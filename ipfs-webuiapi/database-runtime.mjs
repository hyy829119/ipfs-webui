export function databaseLimits (config) {
  const integer = (name, fallback, maximum) => {
    const value = Number(config[name] ?? fallback)
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`)
    return value
  }
  return {
    queryTimeout: integer('databaseQueryTimeoutMs', 15_000, 300_000),
    acquireTimeout: integer('databaseAcquireTimeoutMs', 10_000, 300_000),
    queueLimit: integer('databaseQueueLimit', 100, 10_000)
  }
}

export function unavailable (code) {
  return Object.assign(new Error(`Database operation unavailable (${code})`), { code: 'DATABASE_ERROR', dbCode: code, status: 503 })
}

/** Infrastructure messages never contain SQL, parameters or credentials. */
export function databaseReporter (config, type) {
  return (event, error) => {
    const raw = String(error?.dbCode || error?.code || 'UNKNOWN')
    const code = /^[A-Z0-9_]{1,64}$/.test(raw) ? raw : 'UNKNOWN'
    try { Promise.resolve(config.logger?.error?.({ event, databaseType: type, code })).catch(() => {}) } catch {}
  }
}

/** Bound both work in flight and queued callers; expired callers are removed immediately. */
export function databaseLifecycle (queries, transact, disconnect, { concurrency, acquireTimeout, queueLimit, report }) {
  const queued = []
  let running = 0
  let closing
  let drained
  const complete = () => {
    if (!running && !queued.length) drained?.()
  }
  const start = (item) => {
    clearTimeout(item.timer)
    running++
    Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
      running--
      if (queued.length) start(queued.shift())
      complete()
    })
  }
  const invoke = (operation) => {
    if (closing) return Promise.reject(new Error('Database is closed'))
    if (running >= concurrency && queued.length >= queueLimit) {
      const error = unavailable('QUEUE_FULL')
      report('database_overloaded', error)
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      const item = { operation, resolve, reject }
      if (running < concurrency) return start(item)
      item.timer = setTimeout(() => {
        const index = queued.indexOf(item)
        if (index === -1) return
        queued.splice(index, 1)
        const error = unavailable('ACQUIRE_TIMEOUT')
        report('database_acquire_timeout', error)
        reject(error)
        complete()
      }, acquireTimeout)
      queued.push(item)
    })
  }
  return {
    get: (sql, params = []) => invoke(() => queries.get(sql, params)),
    all: (sql, params = []) => invoke(() => queries.all(sql, params)),
    run: (sql, params = []) => invoke(() => queries.run(sql, params)),
    transaction: operation => invoke(() => transact(operation)),
    close () {
      if (!closing) {
        const wait = new Promise(resolve => { drained = resolve })
        closing = wait.then(disconnect)
        complete()
      }
      return closing
    }
  }
}

/** The timeout callback must destroy the connection, not return it to a pool. */
export async function boundedOperation (operation, timeoutMs, abort, code = 'QUERY_TIMEOUT') {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          try { abort() } catch {}
          reject(unavailable(code))
        }, timeoutMs)
      })
    ])
  } finally { clearTimeout(timer) }
}

/** Expired callbacks cannot continue querying a released or replaced connection. */
export async function scopedTransaction (queries, operation, timeoutMs, abort) {
  let active = true
  const scoped = Object.fromEntries(Object.entries(queries).map(([name, query]) => [name, (...args) => {
    if (!active) return Promise.reject(unavailable('TRANSACTION_CLOSED'))
    return query(...args)
  }]))
  try {
    return await boundedOperation(() => operation(scoped), timeoutMs, () => {
      active = false
      abort()
    }, 'TRANSACTION_TIMEOUT')
  } finally { active = false }
}
