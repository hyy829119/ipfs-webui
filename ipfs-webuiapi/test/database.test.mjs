import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { isUniqueViolation, openDatabase, postgresParameters } from '../database.mjs'

const databases = JSON.parse(process.env.IFSHARE_TEST_DATABASES || '[]')
const now = '2026-11-10T00:00:00.000Z'

async function insertUser (db, username = 'adapter-user') {
  return db.run("INSERT INTO users (username, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, 'user', 1, ?, ?)", [username, '测试用户', 'test-only-hash', now, now])
}

async function verifyQueriesAndTransactions (db) {
  const inserted = await insertUser(db)
  assert.equal(inserted.changes, 1)
  assert.equal(typeof inserted.lastInsertRowid, 'number')
  assert.ok(inserted.lastInsertRowid > 0)
  const user = await db.get('SELECT * FROM users WHERE id = ?', [inserted.lastInsertRowid])
  assert.equal(user.username, 'adapter-user')
  assert.equal(user.display_name, '测试用户')
  assert.equal(user.enabled, 1)
  assert.equal(typeof user.id, 'number')
  assert.equal((await db.run('UPDATE users SET display_name = ? WHERE id = ?', ['Updated', user.id])).changes, 1)
  assert.equal((await db.all('SELECT * FROM users WHERE username = ?', ['adapter-user'])).length, 1)
  assert.equal((await db.get('SELECT ? AS sample', ["'; DROP TABLE users;--"])).sample, "'; DROP TABLE users;--")
  assert.equal(await db.get('SELECT * FROM users WHERE id = ?', [-1]), undefined)
  await assert.rejects(insertUser(db, 'ADAPTER-USER'), error => isUniqueViolation(error))
  await assert.rejects(db.run('INSERT INTO users (username, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', ['sensitive-username', '', 'private-password-hash', 'private-invalid-role', now, now]), error => {
    const serialized = error.message + JSON.stringify(error)
    for (const secret of ['sensitive-username', 'private-password-hash', 'private-invalid-role']) assert.equal(serialized.includes(secret), false)
    assert.equal(error.code, 'DATABASE_ERROR')
    return true
  })
  await assert.rejects(db.transaction(async tx => {
    await insertUser(tx, 'rolled-back')
    await tx.run('UPDATE users SET enabled = 0 WHERE id = ?', [user.id])
    throw new Error('Rollback this transaction')
  }), /Rollback this transaction/)
  assert.equal(await db.get('SELECT * FROM users WHERE username = ?', ['rolled-back']), undefined)
  assert.equal((await db.get('SELECT enabled FROM users WHERE id = ?', [user.id])).enabled, 1)
  const committed = await db.transaction(async tx => {
    const row = await insertUser(tx, 'committed-user')
    return tx.get('SELECT * FROM users WHERE id = ?', [row.lastInsertRowid])
  })
  assert.equal(committed.username, 'committed-user')
  const token = 'a'.repeat(64)
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [token, user.id, 1_900_000_000_000, 1_800_000_000_000])
  const session = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [token])
  assert.equal(session.expires_at, 1_900_000_000_000)
  const eventId = randomUUID()
  const insertLog = () => db.run('INSERT INTO operation_logs (user_id, username, event_id, action, file_name, file_path, cid, file_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [user.id, user.username, eventId, 'download', '测试.txt', '/测试.txt', '', 2, now])
  const logged = await insertLog()
  assert.equal(logged.changes, 1)
  assert.equal(typeof logged.lastInsertRowid, 'number')
  await assert.rejects(insertLog(), error => isUniqueViolation(error))
  await db.run('DELETE FROM users WHERE id = ?', [user.id])
  assert.equal(await db.get('SELECT * FROM sessions WHERE token_hash = ?', [token]), undefined)
  assert.equal((await db.get('SELECT * FROM operation_logs WHERE id = ?', [logged.lastInsertRowid])).file_count, 2)
}

it('SQLite preserves the original user/session schema while adding operation logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifshare-db-legacy-'))
  const databasePath = join(directory, 'existing.sqlite')
  let db
  try {
    const previous = new DatabaseSync(databasePath)
    previous.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
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
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    previous.prepare("INSERT INTO users (username, display_name, password_hash, role, enabled, created_at, updated_at) VALUES ('legacy-admin', '', 'preserved-password-hash', 'admin', 1, ?, ?)").run(now, now)
    previous.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)').run('b'.repeat(64), 1_900_000_000_000, 1_800_000_000_000)
    previous.close()
    db = await openDatabase({ databaseType: 'sqlite', databasePath })
    assert.equal((await db.get('SELECT password_hash FROM users WHERE id = 1')).password_hash, 'preserved-password-hash')
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM sessions')).count, 1)
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM operation_logs')).count, 0)
    await verifyQueriesAndTransactions(db)
    await db.close()
    db = await openDatabase({ databaseType: 'sqlite', databasePath })
    assert.equal((await db.get('SELECT password_hash FROM users WHERE id = 1')).password_hash, 'preserved-password-hash')
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM operation_logs')).count, 1)
  } finally {
    await db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('SQLite isolates queued queries from an unfinished transaction and supports rollback and close', async () => {
  const db = await openDatabase({ databaseType: 'sqlite', databasePath: ':memory:' })
  let started
  let release
  const entered = new Promise(resolve => { started = resolve })
  const resume = new Promise(resolve => { release = resolve })
  try {
    const transaction = db.transaction(async tx => {
      await insertUser(tx, 'uncommitted-user')
      started()
      await resume
      throw new Error('Expected rollback')
    })
    await Promise.race([entered, transaction])
    const queued = db.get('SELECT COUNT(*) AS count FROM users')
    const rejected = assert.rejects(transaction, /Expected rollback/)
    release()
    await rejected
    assert.equal((await queued).count, 0)
    await verifyQueriesAndTransactions(db)
  } finally { release(); await db.close() }
  await db.close()
  await assert.rejects(db.get('SELECT COUNT(*) AS count FROM users'))
})

it('SQLite initializes a new file concurrently without failing while enabling WAL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifshare-db-concurrent-'))
  try {
    for (let round = 0; round < 4; round++) {
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => openDatabase({ databasePath: join(directory, `${round}.sqlite`) })))
      const instances = results.filter(result => result.status === 'fulfilled').map(result => result.value)
      try {
        for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message)
        await Promise.all(instances.map((db, index) => db.transaction(tx => insertUser(tx, `concurrent-${index}`))))
        assert.equal((await instances[0].get('SELECT COUNT(*) AS count FROM users')).count, 4)
      } finally { await Promise.all(instances.map(db => db.close())) }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects unknown database types and unsafe database identifiers', async () => {
  await assert.rejects(openDatabase({ databaseType: 'unsupported', databasePath: ':memory:' }), /type|unsupported/i)
  for (const databaseType of ['mysql', 'mariadb', 'postgresql']) {
    await assert.rejects(openDatabase({ databaseType, databaseName: 'db; DROP DATABASE production', databaseHost: '127.0.0.1', databasePort: 1, databaseUser: 'test', databasePassword: 'test-only' }), /name|identifier/i)
  }
})

it('translates PostgreSQL placeholders while preserving literals, identifiers and nested comments', () => {
  const sql = String.raw`SELECT ?, '?', "?", 'it''s ?', E'it\'s ?', $$?$$, $body$?$body$, ? /* outer ? /* inner ? */ ? */ -- ignored ?
WHERE id = ?`
  const expected = String.raw`SELECT $1, '?', "?", 'it''s ?', E'it\'s ?', $$?$$, $body$?$body$, $2 /* outer ? /* inner ? */ ? */ -- ignored ?
WHERE id = $3`
  assert.equal(postgresParameters(sql), expected)
})

const expensiveSql = 'WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 100000000) SELECT sum(n) AS total FROM numbers'

it('SQLite keeps the event loop responsive, kills timed-out native queries, and recovers the file with its transaction rolled back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifshare-db-timeout-'))
  const events = []
  const db = await openDatabase({ databasePath: join(directory, 'timeout.sqlite'), databaseQueryTimeoutMs: 200, logger: { error: event => events.push(event) } })
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  const started = performance.now()
  try {
    await insertUser(db, 'durable-user')
    await assert.rejects(db.transaction(async tx => {
      await insertUser(tx, 'interrupted-user')
      await tx.get(expensiveSql)
    }), error => error.dbCode === 'QUERY_TIMEOUT')
    assert.ok(ticks >= 3, 'SQLite must not block the HTTP event loop during its native query')
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM users')).count, 1)
    assert.equal((await db.get('SELECT username FROM users')).username, 'durable-user')
    assert.ok(performance.now() - started < 2000, 'A terminated native query must not delay reconnect until SQL finishes')
    assert.ok(events.some(event => event.event === 'database_query_timeout'))
    assert.equal(JSON.stringify(events).includes(expensiveSql), false)
  } finally {
    clearInterval(timer)
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('SQLite bounds and expires queued operations without executing them later', async () => {
  const db = await openDatabase({ databasePath: ':memory:', databaseQueueLimit: 1, databaseAcquireTimeoutMs: 40 })
  let enter
  let resume
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  const transaction = db.transaction(async tx => { await tx.get('SELECT 1'); enter(); await gate })
  try {
    await entered
    const timedOut = assert.rejects(insertUser(db, 'must-not-be-inserted'), error => error.dbCode === 'ACQUIRE_TIMEOUT' && error.status === 503)
    await assert.rejects(db.get('SELECT 1'), error => error.dbCode === 'QUEUE_FULL' && error.status === 503)
    await timedOut
    resume()
    await transaction
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM users')).count, 0)
    let staleTransaction
    await db.transaction(async tx => { staleTransaction = tx; await tx.get('SELECT 1') })
    await assert.rejects(staleTransaction.get('SELECT 1'), error => error.dbCode === 'TRANSACTION_CLOSED')
  } finally { resume(); await transaction; await db.close() }
})

it('SQLite memory mode fails closed after interruption instead of silently creating an empty database', async () => {
  const db = await openDatabase({ databasePath: ':memory:', databaseQueryTimeoutMs: 80 })
  try {
    await insertUser(db, 'must-not-be-lost-silently')
    await assert.rejects(db.get(expensiveSql), error => error.dbCode === 'QUERY_TIMEOUT')
    await assert.rejects(db.get('SELECT COUNT(*) AS count FROM users'), error => error.dbCode === 'SQLITE_MEMORY_UNAVAILABLE')
  } finally { await db.close() }
})

it('SQLite bounds a stuck transaction callback and rejects its late queries after recovery', async () => {
  const db = await openDatabase({ databasePath: ':memory:', databaseQueryTimeoutMs: 20 })
  let staleTransaction
  try {
    await assert.rejects(db.transaction(async tx => {
      staleTransaction = tx
      await new Promise(() => {})
    }), error => error.dbCode === 'TRANSACTION_TIMEOUT')
    await assert.rejects(staleTransaction.get('SELECT 1'), error => error.dbCode === 'TRANSACTION_CLOSED')
  } finally { await db.close() }
})

async function dropDatabase (config) {
  const options = { host: config.databaseHost, port: config.databasePort, user: config.databaseUser, password: config.databasePassword, ssl: config.databaseSsl || undefined }
  if (config.databaseType === 'postgresql') {
    const { default: pg } = await import('pg')
    const client = new pg.Client({ ...options, database: 'postgres' })
    await client.connect()
    try { await client.query(`DROP DATABASE IF EXISTS "${config.databaseName}"`) } finally { await client.end() }
  } else {
    const { default: mysql } = await import('mysql2/promise')
    const client = await mysql.createConnection(options)
    try { await client.query(`DROP DATABASE IF EXISTS \`${config.databaseName}\``) } finally { await client.end() }
  }
}

if (!databases.length) it('external database adapter integration (set IFSHARE_TEST_DATABASES to enable)', { skip: true }, () => {})

for (const settings of databases) {
  it(`${settings.databaseType}: bounds queue waits, cancels timed-out SQL, rolls back, and reconnects after a terminated idle connection`, async () => {
    const config = { ...settings, databaseName: 'ifshare_limits_' + randomUUID().replaceAll('-', ''), databasePoolSize: 1, databaseQueryTimeoutMs: 200, databaseAcquireTimeoutMs: 80, databaseQueueLimit: 1 }
    let db
    let release
    let transaction
    try {
      db = await openDatabase(config)
      if (settings.databaseType === 'postgresql') {
        assert.equal((await db.get('SHOW statement_timeout')).statement_timeout, '200ms')
      } else {
        const variable = settings.databaseType === 'mariadb' ? 'max_statement_time' : 'max_execution_time'
        const limit = await db.get(`SELECT @@session.${variable} AS value`)
        assert.equal(Number(limit.value), settings.databaseType === 'mariadb' ? 0.2 : 200)
        assert.equal((await db.get('SELECT @@session.innodb_lock_wait_timeout AS value')).value, 1)
      }
      let enter
      const entered = new Promise(resolve => { enter = resolve })
      const gate = new Promise(resolve => { release = resolve })
      transaction = db.transaction(async tx => { await tx.get('SELECT 1'); enter(); await gate })
      await entered
      const queued = assert.rejects(db.get('SELECT 1'), error => error.dbCode === 'ACQUIRE_TIMEOUT')
      await assert.rejects(db.get('SELECT 1'), error => error.dbCode === 'QUEUE_FULL')
      await queued
      release()
      await transaction
      // A bare MySQL SELECT SLEEP() reports interruption as a successful row (value 1).
      // Use SLEEP inside a table query so the server returns its actual timeout error.
      const sleepSql = settings.databaseType === 'postgresql' ? 'SELECT pg_sleep(2)' : 'SELECT id FROM users WHERE SLEEP(2) = 0'
      await assert.rejects(db.transaction(async tx => {
        await insertUser(tx, 'timeout-rollback')
        await tx.get(sleepSql)
      }), error => ['QUERY_TIMEOUT', '57014'].includes(error.dbCode))
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM users')).count, 0)
      const connectionId = await db.get(settings.databaseType === 'postgresql' ? 'SELECT pg_backend_pid() AS id' : 'SELECT CONNECTION_ID() AS id')
      const options = { host: config.databaseHost, port: config.databasePort, user: config.databaseUser, password: config.databasePassword }
      if (settings.databaseType === 'postgresql') {
        const { default: pg } = await import('pg')
        const control = new pg.Client({ ...options, database: 'postgres' })
        await control.connect()
        try { await control.query('SELECT pg_terminate_backend($1)', [connectionId.id]) } finally { await control.end() }
      } else {
        const { default: mysql } = await import('mysql2/promise')
        const control = await mysql.createConnection(options)
        try { await control.query('KILL CONNECTION ?', [connectionId.id]) } finally { await control.end() }
      }
      await delay(30)
      assert.equal((await db.get('SELECT 1 AS value')).value, 1)
    } finally {
      release?.()
      await transaction?.catch(() => {})
      await db?.close()
      await dropDatabase(config)
    }
  })

  it(`${settings.databaseType}: creates missing schema, preserves data, rolls back and cascades sessions only`, async () => {
    const config = { ...settings, databaseName: 'ifshare_db_' + randomUUID().replaceAll('-', ''), databaseCreate: true }
    let db
    try {
      await assert.rejects(openDatabase({ ...config, databaseCreate: false }))
      db = await openDatabase(config)
      await verifyQueriesAndTransactions(db)
      await db.close()
      db = await openDatabase({ ...config, databaseCreate: false })
      assert.equal(Number((await db.get('SELECT COUNT(*) AS count FROM users')).count), 1)
      assert.equal(Number((await db.get('SELECT COUNT(*) AS count FROM operation_logs')).count), 1)
      const list = await db.all('SELECT * FROM operation_logs WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [1, 1, 0])
      assert.equal(list.length, 1)
      assert.equal(list[0].username, 'adapter-user')
    } finally {
      await db?.close()
      await dropDatabase(config)
    }
  })

  it(`${settings.databaseType}: starts in an existing database without global create permission and fails safely for a missing database`, async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const databaseName = 'ifshare_restricted_' + suffix
    const missingName = 'ifshare_missing_' + suffix
    const username = 'ifshare_test_' + suffix.slice(0, 18)
    const password = 'test_only_' + randomUUID().replaceAll('-', '')
    const connectionOptions = { host: settings.databaseHost, port: settings.databasePort, user: settings.databaseUser, password: settings.databasePassword, ssl: settings.databaseSsl || undefined }
    const config = { ...settings, databaseName, databaseUser: username, databasePassword: password, databaseCreate: true }
    let db
    let admin
    try {
      if (settings.databaseType === 'postgresql') {
        const { default: pg } = await import('pg')
        admin = new pg.Client({ ...connectionOptions, database: 'postgres' })
        await admin.connect()
        // The identifiers and password are generated above from UUID hex characters only.
        await admin.query(`CREATE ROLE "${username}" LOGIN PASSWORD '${password}' NOCREATEDB NOCREATEROLE`)
        await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${username}"`)
        const permission = await admin.query('SELECT rolcreatedb FROM pg_roles WHERE rolname = $1', [username])
        assert.equal(permission.rows[0].rolcreatedb, false)
      } else {
        const { default: mysql } = await import('mysql2/promise')
        admin = await mysql.createConnection(connectionOptions)
        await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
        await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [username, '%', password])
        await admin.query(`GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO ?@?`, [username, '%'])
      }
      db = await openDatabase(config)
      const inserted = await insertUser(db, 'restricted-db-user')
      assert.ok(inserted.lastInsertRowid > 0)
      assert.equal((await db.get('SELECT username FROM users WHERE id = ?', [inserted.lastInsertRowid])).username, 'restricted-db-user')
      await db.close()
      db = undefined
      await assert.rejects(openDatabase({ ...config, databaseName: missingName }), error => {
        assert.equal(error.code, 'DATABASE_ERROR')
        assert.equal((error.message + JSON.stringify(error)).includes(password), false)
        assert.match(error.message, /permission|exist|create/i)
        return true
      })
      if (settings.databaseType === 'postgresql') {
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [missingName])).rowCount, 0)
      } else {
        const [rows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [missingName])
        assert.equal(rows.length, 0)
      }
    } finally {
      await db?.close()
      if (admin) {
        try {
          if (settings.databaseType === 'postgresql') {
            await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
            await admin.query(`DROP DATABASE IF EXISTS "${missingName}"`)
            await admin.query(`DROP ROLE IF EXISTS "${username}"`)
          } else {
            await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
            await admin.query(`DROP DATABASE IF EXISTS \`${missingName}\``)
            await admin.query('DROP USER IF EXISTS ?@?', [username, '%'])
          }
        } finally { await admin.end() }
      }
    }
  })
}
