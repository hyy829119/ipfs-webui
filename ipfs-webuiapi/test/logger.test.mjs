import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createLogger } from '../logger.mjs'

function sink () {
  const stream = new EventEmitter()
  stream.lines = []
  stream.write = line => { stream.lines.push(JSON.parse(line)); return true }
  return stream
}

test('runtime logs contain only safe structured fields, never credentials, SQL or file identifiers', () => {
  const stream = sink()
  const logger = createLogger({ stream, now: () => 0 })
  logger.error({ event: 'api_request_failed', code: 'DATABASE_ERROR', dbCode: 'ECONNREFUSED', status: 503, password: 'secret', token: 'secret', sql: 'SELECT secret', message: 'private-path', cid: 'private-cid', path: '/private', request: { cookie: 'secret' }, userId: 2 })
  assert.deepEqual(stream.lines, [{ time: '1970-01-01T00:00:00.000Z', level: 'error', event: 'api_request_failed', code: 'DATABASE_ERROR', dbCode: 'ECONNREFUSED', status: 503, userId: 2 }])
  logger.warn({ event: 'injected\npassword', code: 'raw secret spaces', userId: NaN })
  assert.equal(stream.lines[1].event, 'service_error')
  assert.equal(stream.lines[1].code, undefined)
})
test('limits repeated errors and reports suppressed counts without unbounded messages', () => {
  const stream = sink()
  let now = 0
  const logger = createLogger({ stream, now: () => now, burst: 2, windowMs: 100 })
  for (let i = 0; i < 1000; i++) logger.error({ event: 'database_unavailable', code: 'ECONNREFUSED' })
  assert.equal(stream.lines.length, 2)
  now = 100
  logger.info({ event: 'service_recovered' })
  assert.equal(stream.lines[2].event, 'log_messages_suppressed')
  assert.equal(stream.lines[2].count, 998)
  assert.equal(stream.lines[3].event, 'service_recovered')
})
test('drops excess output under backpressure and resumes after drain without retaining payloads', () => {
  const stream = sink()
  stream.write = line => { stream.lines.push(JSON.parse(line)); return false }
  const logger = createLogger({ stream })
  logger.error({ event: 'first' })
  for (let i = 0; i < 50; i++) logger.warn({ event: `backpressure_${i}` })
  assert.equal(stream.lines.length, 1)
  assert.equal(stream.listenerCount('drain'), 1)
  stream.emit('drain')
  logger.info({ event: 'resumed' })
  assert.equal(stream.lines[1].suppressed, 50)
})
test('honors log levels and cannot throw due to a broken output stream', () => {
  const stream = sink()
  const logger = createLogger({ level: 'error', stream })
  logger.info({ event: 'ignored' })
  logger.warn({ event: 'ignored' })
  assert.equal(stream.lines.length, 0)
  stream.write = () => { throw new Error('broken pipe') }
  assert.doesNotThrow(() => logger.error({ event: 'failed' }))
  assert.throws(() => createLogger({ level: 'verbose' }), /LOG_LEVEL/)
  createLogger({ level: 'silent', stream }).error({ event: 'ignored' })
})
