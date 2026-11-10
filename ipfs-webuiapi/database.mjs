import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { boundedOperation, databaseLifecycle, databaseLimits, databaseReporter, scopedTransaction, unavailable } from './database-runtime.mjs'

const DATABASE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

function databaseError (operation, error) {
  const code = String(error?.dbCode || error?.code || error?.errcode || '')
  const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN'
  const hints = {
    ECONNREFUSED: 'Database connection was refused; check the host and port.',
    ENOTFOUND: 'Database hostname could not be resolved.',
    ETIMEDOUT: 'Database connection timed out.',
    '28P01': 'Database authentication failed; check the credentials.',
    ER_ACCESS_DENIED_ERROR: 'Database authentication failed; check the credentials.',
    ER_DBACCESS_DENIED_ERROR: 'The database account lacks the required permissions.',
    42501: 'The database account lacks the required permissions.',
    '3D000': 'Database does not exist; enable databaseCreate or create it first.',
    ER_BAD_DB_ERROR: 'Database does not exist; enable databaseCreate or create it first.'
  }
  return Object.assign(new Error(`${operation} failed (${safeCode}). ${hints[safeCode] || 'Check the database connection, permissions and schema.'}`), {
    code: 'DATABASE_ERROR',
    dbCode: safeCode,
    uniqueViolation: isUniqueViolation(error)
  })
}

export function isUniqueViolation (error) {
  return error?.uniqueViolation === true || ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(error?.code) || [1555, 2067].includes(error?.errcode)
}

function safeNumber (value) {
  if (value === null || value === undefined) return value
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds the supported range')
  return number
}

/** Translate parameter tokens without changing quoted strings, identifiers or comments. */
export function postgresParameters (sql) {
  let result = ''
  let index = 0
  let parameter = 0
  while (index < sql.length) {
    const char = sql[index]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      const escapedString = quote === "'" && /[eE]/.test(sql[index - 1] || '') && !/[\w$]/.test(sql[index - 2] || '')
      result += sql[index++]
      while (index < sql.length) {
        const current = sql[index++]
        result += current
        if (escapedString && current === '\\' && index < sql.length) result += sql[index++]
        else if (current === quote) {
          if (sql[index] === quote) result += sql[index++]
          else break
        }
      }
    } else if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index)
      const next = end === -1 ? sql.length : end + 1
      result += sql.slice(index, next)
      index = next
    } else if (sql.startsWith('/*', index)) {
      let depth = 1
      result += sql.slice(index, index + 2)
      index += 2
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { result += '/*'; index += 2; depth++ } else if (sql.startsWith('*/', index)) { result += '*/'; index += 2; depth-- } else result += sql[index++]
      }
    } else if (char === '$' && /^(?:\$\$|\$[a-zA-Z_][a-zA-Z0-9_]*\$)/.test(sql.slice(index))) {
      const delimiter = sql.slice(index).match(/^(?:\$\$|\$[a-zA-Z_][a-zA-Z0-9_]*\$)/)[0]
      const end = sql.indexOf(delimiter, index + delimiter.length)
      const next = end === -1 ? sql.length : end + delimiter.length
      result += sql.slice(index, next)
      index = next
    } else {
      result += char === '?' ? `$${++parameter}` : char
      index++
    }
  }
  return result
}

const sqliteSchema = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('upload', 'download', 'preview')),
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    cid TEXT NOT NULL,
    file_count INTEGER NOT NULL CHECK(file_count >= 1),
    created_at TEXT NOT NULL,
    UNIQUE(user_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS operation_logs_user_id ON operation_logs(user_id, id);
  CREATE INDEX IF NOT EXISTS operation_logs_action_id ON operation_logs(action, id);
`

const mysqlSchema = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL DEFAULT '',
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL CHECK(role IN ('admin', 'user')),
    enabled SMALLINT NOT NULL CHECK(enabled IN (0, 1)),
    created_at VARCHAR(32) NOT NULL,
    updated_at VARCHAR(32) NOT NULL,
    last_login_at VARCHAR(32)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    user_id BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX sessions_user (user_id),
    INDEX sessions_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS operation_logs (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    username VARCHAR(32) NOT NULL,
    event_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(16) NOT NULL CHECK(action IN ('upload', 'download', 'preview')),
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    cid TEXT NOT NULL,
    file_count INTEGER NOT NULL CHECK(file_count >= 1),
    created_at VARCHAR(32) NOT NULL,
    UNIQUE KEY operation_logs_event (user_id, event_id),
    INDEX operation_logs_user_id (user_id, id),
    INDEX operation_logs_action_id (action, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]

const postgresSchema = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(32) NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
    enabled SMALLINT NOT NULL CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (LOWER(username))',
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS operation_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    username TEXT NOT NULL,
    event_id VARCHAR(36) NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('upload', 'download', 'preview')),
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    cid TEXT NOT NULL,
    file_count INTEGER NOT NULL CHECK(file_count >= 1),
    created_at TEXT NOT NULL,
    UNIQUE(user_id, event_id)
  )`,
  'CREATE INDEX IF NOT EXISTS operation_logs_user_id ON operation_logs(user_id, id)',
  'CREATE INDEX IF NOT EXISTS operation_logs_action_id ON operation_logs(action, id)'
]

async function sqliteDatabase (config) {
  const path = config.databasePath
  if (!path || typeof path !== 'string') throw new Error('databasePath is required for SQLite')
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const limits = databaseLimits(config)
  const report = databaseReporter(config, 'sqlite')
  const pending = new Map()
  let child
  let sequence = 0
  let initialized = false
  let stopping = Promise.resolve()
  const invalidate = (error) => {
    const previous = child
    child = null
    for (const task of pending.values()) task.reject(error)
    pending.clear()
    if (previous) {
      stopping = new Promise(resolve => {
        if (previous.exitCode !== null || previous.signalCode !== null) return resolve()
        previous.once('exit', resolve)
        previous.kill('SIGKILL')
      })
    }
  }
  const connect = async () => {
    if (child) return
    if (initialized && path === ':memory:') throw unavailable('SQLITE_MEMORY_UNAVAILABLE')
    await stopping
    const current = fork(fileURLToPath(new URL('./sqlite-process.mjs', import.meta.url)), [], {
      execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    child = current
    let ready
    const started = new Promise((resolve, reject) => { ready = { resolve, reject } })
    current.on('message', message => {
      if ('ready' in message) {
        if (message.ready) ready.resolve()
        else ready.reject(databaseError('SQLite initialization', message.error))
        return
      }
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      if (message.error) task.reject(databaseError('Database query', message.error))
      else task.resolve(message.result)
    })
    const failed = error => {
      if (child !== current) return
      const safe = databaseError('SQLite process', error)
      ready.reject(safe)
      report('database_process_error', safe)
      invalidate(safe)
    }
    current.once('error', failed)
    current.once('exit', () => failed({ code: 'SQLITE_PROCESS_EXIT' }))
    current.send({ method: 'init', path, schema: sqliteSchema, busyTimeout: Math.min(limits.queryTimeout, 5000) }, error => { if (error) failed(error) })
    try {
      await boundedOperation(() => started, Math.max(limits.acquireTimeout, 1000), () => invalidate(unavailable('ACQUIRE_TIMEOUT')), 'ACQUIRE_TIMEOUT')
      initialized = true
    } catch (error) {
      invalidate(error)
      throw error
    }
  }
  const query = async (method, sql, params = []) => {
    await connect()
    const id = ++sequence
    try {
      const value = await boundedOperation(() => new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.send({ id, method, sql, params }, error => { if (error) { pending.delete(id); reject(databaseError('SQLite IPC', error)) } })
      }), limits.queryTimeout, () => invalidate(unavailable('QUERY_TIMEOUT')))
      return method === 'run' ? { changes: safeNumber(value.changes), lastInsertRowid: safeNumber(value.lastInsertRowid) } : value
    } catch (error) {
      if (error.dbCode === 'QUERY_TIMEOUT') report('database_query_timeout', error)
      throw error
    } finally { pending.delete(id) }
  }
  await connect()
  const direct = {
    get: async (sql, params = []) => query('get', sql, params),
    all: async (sql, params = []) => query('all', sql, params),
    run: async (sql, params = []) => query('run', sql, params)
  }
  return databaseLifecycle(direct, async operation => {
    await query('exec', 'BEGIN IMMEDIATE')
    const transactionProcess = child
    const transactionQueries = Object.fromEntries(Object.entries(direct).map(([method, operation]) => [method, (...args) => {
      if (child !== transactionProcess) return Promise.reject(unavailable('TRANSACTION_CLOSED'))
      return operation(...args)
    }]))
    try {
      const result = await scopedTransaction(transactionQueries, operation, limits.queryTimeout * 4, () => invalidate(unavailable('TRANSACTION_TIMEOUT')))
      if (child !== transactionProcess) throw unavailable('TRANSACTION_CLOSED')
      await query('exec', 'COMMIT')
      return result
    } catch (error) {
      if (error.dbCode === 'TRANSACTION_TIMEOUT') report('database_transaction_timeout', error)
      if (child === transactionProcess) {
        try { await query('exec', 'ROLLBACK') } catch (rollbackError) { invalidate(rollbackError) }
      }
      throw error
    }
  }, async () => {
    if (child) {
      try { await query('close') } finally { invalidate(unavailable('DATABASE_CLOSED')) }
    }
    await stopping
  }, { ...limits, concurrency: 1, report })
}

function externalConfig (config, type) {
  const database = config.databaseName || 'ifshare_webui'
  if (typeof database !== 'string' || !DATABASE_NAME.test(database)) throw new Error('databaseName must begin with a letter or underscore and contain only letters, digits or underscores (maximum 63 characters)')
  const port = Number(config.databasePort || (type === 'postgresql' ? 5432 : 3306))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('databasePort must be between 1 and 65535')
  const max = Number(config.databasePoolSize ?? 10)
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error('databasePoolSize must be between 1 and 100')
  const ssl = config.databaseSsl ? { ...(typeof config.databaseSsl === 'object' ? config.databaseSsl : {}), rejectUnauthorized: true, verifyIdentity: true } : undefined
  return { database, host: config.databaseHost || '127.0.0.1', port, user: config.databaseUser, password: config.databasePassword, ssl, max }
}

function mysqlQueries (execute) {
  const rows = (result, fields) => result.map(row => {
    const value = { ...row }
    for (const field of fields) if (field.columnType === 8 && value[field.name] !== null) value[field.name] = safeNumber(value[field.name])
    return value
  })
  return {
    async all (sql, params = []) {
      const [result, fields] = await execute(sql, params)
      return rows(result, fields)
    },
    async get (sql, params = []) {
      const [result, fields] = await execute(sql, params)
      return rows(result, fields)[0]
    },
    async run (sql, params = []) {
      const [result] = await execute(sql, params)
      return { changes: safeNumber(result.affectedRows), lastInsertRowid: safeNumber(result.insertId || 0) }
    }
  }
}

async function mysqlDatabase (config, type) {
  let mysql
  try { mysql = await import('mysql2/promise') } catch { throw new Error('MySQL/MariaDB driver is not installed; run npm ci --prefix ipfs-webuiapi') }
  const { max, ...base } = externalConfig(config, type)
  const limits = databaseLimits(config)
  const report = databaseReporter(config, type)
  const options = { ...base, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, connectTimeout: limits.acquireTimeout, enableKeepAlive: true }
  // The application scheduler owns the bounded wait queue; do not create a second driver queue.
  const makePool = () => {
    const pool = mysql.createPool({ ...options, connectionLimit: max, maxIdle: max, idleTimeout: 60_000, waitForConnections: false })
    pool.on('connection', connection => {
      // Enqueue session initialization before the pool hands this new connection to a caller.
      // MySQL applies its execution limit to SELECT; both engines also bound lock waits.
      const execution = type === 'mariadb' ? `max_statement_time = ${limits.queryTimeout / 1000}` : `max_execution_time = ${limits.queryTimeout}`
      const lockWait = Math.max(1, Math.ceil(limits.queryTimeout / 1000))
      const timer = setTimeout(() => {
        connection.destroy()
        report('database_session_configuration_error', unavailable('QUERY_TIMEOUT'))
      }, limits.queryTimeout)
      connection.query(`SET SESSION ${execution}, innodb_lock_wait_timeout = ${lockWait}, lock_wait_timeout = ${lockWait}`, error => {
        clearTimeout(timer)
        if (error) {
          connection.destroy()
          report('database_session_configuration_error', error)
        }
      })
    })
    return pool
  }
  let pool = makePool()
  const session = connection => {
    let active = true
    const destroy = () => {
      if (!active) return
      active = false
      connection.destroy()
    }
    const execute = async (sql, params = [], prepared = true) => {
      if (!active) throw unavailable('CONNECTION_CLOSED')
      try {
        return await boundedOperation(() => prepared ? connection.execute(sql, params) : connection.query(sql, params), limits.queryTimeout, destroy)
      } catch (error) {
        const timeout = [1969, 3024].includes(error.errno)
        if (timeout) destroy()
        const failure = timeout ? unavailable('QUERY_TIMEOUT') : error
        if (failure.dbCode === 'QUERY_TIMEOUT') report('database_query_timeout', failure)
        throw failure.code === 'DATABASE_ERROR' ? failure : databaseError('Database query', failure)
      }
    }
    return { queries: mysqlQueries(execute), raw: sql => execute(sql, [], false), destroy, release: () => { if (active) { active = false; connection.release() } } }
  }
  const acquire = async () => {
    let expired = false
    try {
      return await boundedOperation(async () => {
        const connection = await pool.getConnection()
        if (expired) { connection.destroy(); throw unavailable('ACQUIRE_TIMEOUT') }
        return session(connection)
      }, limits.acquireTimeout, () => { expired = true }, 'ACQUIRE_TIMEOUT')
    } catch (error) {
      report('database_connection_error', error)
      throw error.code === 'DATABASE_ERROR' ? error : databaseError('Database connection', error)
    }
  }
  try {
    try {
      const connection = await pool.getConnection()
      connection.release()
    } catch (error) {
      if (error.code !== 'ER_BAD_DB_ERROR' || config.databaseCreate === false) throw error
      await pool.end()
      const { database, ...maintenanceOptions } = options
      const maintenance = await mysql.createConnection(maintenanceOptions)
      try {
        await boundedOperation(() => maintenance.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`), limits.queryTimeout, () => maintenance.destroy())
      } finally { await boundedOperation(() => maintenance.end(), limits.queryTimeout, () => maintenance.destroy()) }
      pool = makePool()
    }
    const connection = await pool.getConnection()
    const initialization = session(connection)
    let locked = false
    try {
      const [rows] = await initialization.raw("SELECT GET_LOCK('ifshare_webui_schema_init', 15) AS acquired")
      if (Number(rows[0].acquired) !== 1) throw Object.assign(new Error('Schema lock timed out'), { code: 'SCHEMA_LOCK_TIMEOUT' })
      locked = true
      for (const statement of mysqlSchema) await initialization.raw(statement)
    } finally {
      try {
        if (locked) await initialization.raw("SELECT RELEASE_LOCK('ifshare_webui_schema_init')")
      } catch {
        initialization.destroy()
      } finally { initialization.release() }
    }
  } catch (error) {
    await pool.end().catch(() => {})
    throw databaseError(`${type} initialization`, error)
  }
  const queries = Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (sql, params) => {
    const connection = await acquire()
    try { return await connection.queries[method](sql, params) } finally { connection.release() }
  }]))
  return databaseLifecycle(queries, async operation => {
    const connection = await acquire()
    try {
      await connection.raw('BEGIN')
      const result = await scopedTransaction(connection.queries, operation, limits.queryTimeout * 4, connection.destroy)
      await connection.raw('COMMIT')
      return result
    } catch (error) {
      if (error.dbCode === 'TRANSACTION_TIMEOUT') report('database_transaction_timeout', error)
      await connection.raw('ROLLBACK').catch(connection.destroy)
      throw error
    } finally { connection.release() }
  }, () => pool.end(), { ...limits, concurrency: max, report })
}

function postgresQueries (execute) {
  const query = async (sql, params) => {
    return execute(postgresParameters(sql), params)
  }
  return {
    async all (sql, params = []) { return (await query(sql, params)).rows },
    async get (sql, params = []) { return (await query(sql, params)).rows[0] },
    async run (sql, params = []) {
      const insert = /^\s*INSERT\s+INTO\s+(?:"?users"?|"?operation_logs"?)\s*\(/i.test(sql)
      const statement = insert && !/\bRETURNING\b/i.test(sql) ? `${sql.trim().replace(/;$/, '')} RETURNING id` : sql
      const result = await query(statement, params)
      return { changes: result.rowCount || 0, lastInsertRowid: result.rows[0]?.id ?? 0 }
    }
  }
}

async function postgresDatabase (config) {
  let pg
  try { const module = await import('pg'); pg = module.default || module } catch { throw new Error('PostgreSQL driver is not installed; run npm ci --prefix ipfs-webuiapi') }
  const base = externalConfig(config, 'postgresql')
  const limits = databaseLimits(config)
  const report = databaseReporter(config, 'postgresql')
  const options = {
    ...base,
    connectionTimeoutMillis: limits.acquireTimeout,
    idleTimeoutMillis: 60_000,
    statement_timeout: limits.queryTimeout,
    query_timeout: limits.queryTimeout,
    lock_timeout: limits.queryTimeout,
    idle_in_transaction_session_timeout: limits.queryTimeout * 4,
    keepAlive: true,
    types: { getTypeParser: (oid, format) => oid === 20 && format !== 'binary' ? safeNumber : pg.types.getTypeParser(oid, format) }
  }
  const makePool = () => {
    const pool = new pg.Pool(options)
    // An idle client can disconnect between requests. The pool removes it automatically.
    pool.on('error', error => report('database_idle_connection_error', error))
    return pool
  }
  let pool = makePool()
  const acquire = async () => {
    let connection
    try { connection = await pool.connect() } catch (error) {
      report('database_connection_error', error)
      throw databaseError('Database connection', error)
    }
    let active = true
    const destroy = () => {
      if (!active) return
      active = false
      connection.release(true)
    }
    const execute = async (sql, params = []) => {
      if (!active) throw unavailable('CONNECTION_CLOSED')
      try {
        return await boundedOperation(() => connection.query(sql, params), limits.queryTimeout, destroy)
      } catch (error) {
        const timeout = error.code === '57014'
        if (timeout) destroy()
        const failure = timeout ? unavailable('QUERY_TIMEOUT') : error
        if (failure.dbCode === 'QUERY_TIMEOUT') report('database_query_timeout', failure)
        throw failure.code === 'DATABASE_ERROR' ? failure : databaseError('Database query', failure)
      }
    }
    return { queries: postgresQueries(execute), raw: sql => execute(sql), destroy, release: () => { if (active) { active = false; connection.release() } } }
  }
  try {
    try { await pool.query('SELECT 1') } catch (error) {
      if (error.code !== '3D000' || config.databaseCreate === false) throw error
      await pool.end()
      const maintenance = new pg.Client({ ...options, database: 'postgres' })
      try {
        await maintenance.connect()
        if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [base.database])).rowCount) {
          try { await maintenance.query(`CREATE DATABASE "${base.database}"`) } catch (creationError) {
            if (!['42P04', '23505'].includes(creationError.code)) throw creationError
          }
        }
      } finally { await maintenance.end().catch(() => {}) }
      pool = makePool()
    }
    const connection = await pool.connect()
    try {
      await connection.query('BEGIN')
      await connection.query('SELECT pg_advisory_xact_lock(1684632436)')
      for (const statement of postgresSchema) await connection.query(statement)
      await connection.query('COMMIT')
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {})
      throw error
    } finally { connection.release() }
  } catch (error) {
    await pool.end().catch(() => {})
    throw databaseError('PostgreSQL initialization', error)
  }
  const queries = Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (sql, params) => {
    const connection = await acquire()
    try { return await connection.queries[method](sql, params) } finally { connection.release() }
  }]))
  return databaseLifecycle(queries, async operation => {
    const connection = await acquire()
    try {
      await connection.raw('BEGIN')
      const result = await scopedTransaction(connection.queries, operation, limits.queryTimeout * 4, connection.destroy)
      await connection.raw('COMMIT')
      return result
    } catch (error) {
      if (error.dbCode === 'TRANSACTION_TIMEOUT') report('database_transaction_timeout', error)
      await connection.raw('ROLLBACK').catch(connection.destroy)
      throw error
    } finally { connection.release() }
  }, () => pool.end(), { ...limits, concurrency: base.max, report })
}

/** Every transaction callback must use its tx argument, never the outer database. */
export async function openDatabase (config = {}) {
  let type = String(config.databaseType || 'sqlite').trim().toLowerCase()
  if (['postgres', 'postsql'].includes(type)) type = 'postgresql'
  if (type === 'sqlite') return sqliteDatabase(config)
  if (type === 'mysql' || type === 'mariadb') return mysqlDatabase(config, type)
  if (type === 'postgresql') return postgresDatabase(config)
  throw new Error('databaseType must be sqlite, mysql, mariadb or postgresql')
}
