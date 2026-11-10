import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

let database
const failure = error => ({ code: error?.code, errcode: error?.errcode })

process.on('message', ({ id, method, sql, params, path, schema, busyTimeout }) => {
  if (method === 'init') {
    const initialize = (attempt = 0) => {
      try {
        if (!database) {
          database = new DatabaseSync(path)
          if (path !== ':memory:') chmodSync(path, 0o600)
          database.exec(`PRAGMA busy_timeout = ${busyTimeout}; PRAGMA foreign_keys = ON;`)
        }
        // SQLite can skip its busy handler when concurrent WAL activation would deadlock.
        // Retry only this idempotent schema initialization, never application writes.
        database.exec('PRAGMA journal_mode = WAL;')
        database.exec(schema)
        process.send({ ready: true })
      } catch (error) {
        if ([5, 6].includes(error.errcode & 255) && attempt < 20) {
          setTimeout(() => initialize(attempt + 1), Math.min(10 * (attempt + 1), 100))
          return
        }
        try { database?.close() } catch {}
        process.send({ ready: false, error: failure(error) })
      }
    }
    initialize()
    return
  }
  try {
    let result
    if (method === 'close') database.close()
    else if (method === 'exec') database.exec(sql)
    else result = database.prepare(sql)[method](...params)
    process.send({ id, result })
  } catch (error) { process.send({ id, error: failure(error) }) }
})

// Parent termination must not leave an idle database child behind.
process.once('disconnect', () => process.exit(0))
