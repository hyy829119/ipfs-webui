import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { openDatabase as updated } from '../database.mjs'
// Reproduce the earlier synchronous query path for a controlled comparison.
// SQLite calls are synchronous here, serialized by promises as in the previous adapter.
async function previous (config) {
  const db = new DatabaseSync(config.databasePath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  let tail = Promise.resolve()
  const queue = operation => {
    const pending = tail.then(operation)
    tail = pending.catch(() => {})
    return pending
  }
  const query = (method, sql, params) => db.prepare(sql)[method](...params)
  return {
    get: (sql, params = []) => queue(() => query('get', sql, params)),
    all: (sql, params = []) => queue(() => query('all', sql, params)),
    close: () => queue(() => db.close())
  }
}

const directory = await mkdtemp(join(tmpdir(), 'ifshare-review-benchmark-'))
const file = join(directory, 'logs.sqlite')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { note: 'Local synthetic query workload; before reproduces the previous synchronous main-thread adapter. parentRssMiB excludes the SQLite child process.', records: 100000, requests: 40, concurrency: 8, node: process.version, results: [] }
try {
  const schema = await updated({ databasePath: file })
  await schema.close()
  const seed = new DatabaseSync(file)
  seed.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100000)
    INSERT INTO operation_logs (user_id,username,event_id,action,file_name,file_path,cid,file_count,created_at)
    SELECT (n % 100) + 1, 'user-' || (n % 100), 'event-' || n,
      CASE n % 3 WHEN 0 THEN 'upload' WHEN 1 THEN 'download' ELSE 'preview' END,
      'document-' || n || '.txt', '/documents/project-' || (n % 500) || '/document-' || n || '.txt', 'synthetic-cid-' || n, 1, '2026-11-10T00:00:00.000Z' FROM seq`)
  seed.close()
  for (const [name, open] of [['before', previous], ['after', updated]]) {
    const db = await open({ databasePath: file })
    let previousBeat = performance.now()
    let maxLoopDelayMs = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxLoopDelayMs = Math.max(maxLoopDelayMs, now - previousBeat - 10)
      previousBeat = now
    }, 10)
    const durations = []
    await delay(30)
    const start = performance.now()
    try {
      for (let batch = 0; batch < 5; batch++) {
        await Promise.all(Array.from({ length: 8 }, async (_, index) => {
          const began = performance.now()
          const pattern = `%document-${(batch * 8 + index) % 10}%`
          const params = [pattern, pattern, pattern, pattern]
          const where = "WHERE LOWER(file_name) LIKE LOWER(?) ESCAPE '!' OR LOWER(file_path) LIKE LOWER(?) ESCAPE '!' OR LOWER(cid) LIKE LOWER(?) ESCAPE '!' OR LOWER(username) LIKE LOWER(?) ESCAPE '!'"
          await db.get(`SELECT COUNT(*) AS count FROM operation_logs ${where}`, params)
          await db.all(`SELECT * FROM operation_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, 20, 2000])
          durations.push(performance.now() - began)
        }))
      }
      const elapsedMs = performance.now() - start
      await delay(30)
      durations.sort((a, b) => a - b)
      report.results.push({ name, elapsedMs: Math.round(elapsedMs), queryPairsPerSecond: +(40000 / elapsedMs).toFixed(1), latencyP50Ms: Math.round(durations[19]), latencyP95Ms: Math.round(durations[37]), maxLoopDelayMs: Math.round(maxLoopDelayMs), parentRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) })
    } finally { clearInterval(timer); await db.close() }
  }
  console.log(JSON.stringify(report, null, 2))
} finally { await rm(directory, { recursive: true, force: true }) }
