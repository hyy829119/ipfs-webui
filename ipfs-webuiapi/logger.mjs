const levels = { info: 20, warn: 30, error: 40, silent: Infinity }
const numericFields = ['status', 'durationMs', 'userId', 'actorId', 'count', 'port']
const tokenFields = ['code', 'dbCode', 'channel', 'method', 'databaseType']

// Only explicit operational fields are allowed. Never serialize Error, SQL or requests.
export function createLogger ({ level = 'info', stream = process.stderr, now = Date.now, windowMs = 60_000, burst = 10 } = {}) {
  if (!Object.hasOwn(levels, level)) throw new Error('WEBUI_API_LOG_LEVEL must be info, warn, error or silent')
  const buckets = new Map()
  let blocked = false
  let dropped = 0
  const onDrain = () => { blocked = false }
  const onError = () => { blocked = true }
  stream.on('error', onError)
  const output = (record) => {
    if (blocked || stream.destroyed || stream.writableEnded) { dropped++; return }
    if (dropped) { record.suppressed = (record.suppressed || 0) + dropped; dropped = 0 }
    try {
      if (stream.write(JSON.stringify(record) + '\n') === false) {
        blocked = true
        stream.once('drain', onDrain)
      }
    } catch { dropped++ }
  }
  const log = (severity, fields) => {
    if (levels[severity] < levels[level] || !fields || typeof fields.event !== 'string') return
    const timestamp = now()
    const event = /^[a-z][a-z0-9_]{0,63}$/.test(fields.event) ? fields.event : 'service_error'
    const record = { time: new Date(timestamp).toISOString(), level: severity, event }
    for (const key of tokenFields) {
      if (typeof fields[key] === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(fields[key])) record[key] = fields[key]
    }
    for (const key of numericFields) {
      if (Number.isFinite(fields[key]) && fields[key] >= 0) record[key] = fields[key]
    }
    const key = `${severity}:${event}:${record.code || ''}:${record.channel || ''}`
    for (const [name, value] of buckets) {
      if (value.expiresAt <= timestamp) {
        buckets.delete(name)
        if (value.suppressed) output({ time: record.time, level: value.level, event: 'log_messages_suppressed', count: value.suppressed, code: value.event })
      }
    }
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= 128) { dropped++; return }
      bucket = { count: 0, suppressed: 0, expiresAt: timestamp + windowMs, level: severity, event }
      buckets.set(key, bucket)
    }
    if (++bucket.count > burst) { bucket.suppressed++; return }
    output(record)
  }
  return {
    info: fields => log('info', fields),
    warn: fields => log('warn', fields),
    error: fields => log('error', fields),
    close: () => {
      blocked = true
      buckets.clear()
      stream.off('drain', onDrain)
      stream.off('error', onError)
    }
  }
}
