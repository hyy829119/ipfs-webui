import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'node:test'
import { createApi } from '../api.mjs'
import { fixture, login } from './fixtures.mjs'

function event () {
  return { eventId: randomUUID(), action: 'preview', fileName: 'private-name.txt', filePath: '/private/path', cid: 'private-cid', fileCount: 1 }
}

it('returns a bounded response for a malformed request URL rather than rejecting the HTTP handler', async () => {
  const api = await createApi({ databasePath: ':memory:' })
  const response = { setHeader () {}, end (body) { this.body = JSON.parse(body) } }
  try {
    assert.equal(await api.handle({ url: 'http://[' }, response), true)
    assert.equal(response.statusCode, 400)
    assert.equal(response.body.error.code, 'INVALID_QUERY')
  } finally { await api.close() }
})

it('bounds total JSON reception time even when the client continues sending bytes', async () => {
  const records = []
  const app = await fixture({ bodyTimeoutMs: 200, logger: { warn: record => records.push(record) } })
  let pending
  let drip
  try {
    const admin = await login(app)
    pending = await app.pendingJson('/logs', { cookie: admin.cookie, body: event() })
    drip = setInterval(() => pending.write(' '), 40)
    const response = await pending.response
    clearInterval(drip)
    assert.equal(response.status, 408)
    assert.equal(response.body.error.code, 'REQUEST_TIMEOUT')
    assert.equal(response.headers.connection, 'close')
    await pending.closed
    assert.equal((await app.request('/logs', { cookie: admin.cookie })).body.total, 0)
    assert.equal((await app.request('/auth/session', { cookie: admin.cookie })).status, 200)
    assert.deepEqual(records, [{ event: 'api_request_timeout', code: 'REQUEST_TIMEOUT', status: 408 }])
    assert.equal(JSON.stringify(records).includes('private-'), false)
  } finally {
    clearInterval(drip)
    pending?.cancel()
    await app.close()
  }
})

it('cancels an unfinished JSON body immediately during shutdown and rejects new work', async () => {
  const app = await fixture()
  let pending
  try {
    const admin = await login(app)
    pending = await app.pendingJson('/logs', { cookie: admin.cookie, body: event() })
    const started = Date.now()
    const closing = app.api.close()
    assert.equal(app.api.close(), closing)
    const response = await pending.response
    await closing
    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'SERVICE_UNAVAILABLE')
    assert.ok(Date.now() - started < 2000)
    assert.equal((await app.request('/auth/challenge')).status, 503)
    await assert.rejects(app.api.authenticate({ headers: { cookie: admin.cookie } }), error => error.status === 503)
    const db = new DatabaseSync(app.databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get().count, 0)
    db.close()
  } finally { pending?.cancel(); await app.close() }
})

it('waits for an admitted password derivation and its transaction before closing the database', async () => {
  const app = await fixture()
  let hook
  try {
    const admin = await login(app)
    let entered
    const deriving = new Promise(resolve => { entered = resolve })
    hook = createHook({ init: (_id, type) => { if (type === 'SCRYPTREQUEST') entered() } })
    hook.enable()
    const creating = app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'closing-user' } })
    await Promise.race([deriving, creating.then(() => { throw new Error('Request completed before password derivation was observed') })])
    hook.disable()
    const closing = app.api.close()
    assert.equal(app.api.close(), closing)
    assert.equal((await creating).status, 201)
    await closing
    const db = new DatabaseSync(app.databasePath)
    assert.equal(db.prepare('SELECT username FROM users WHERE username = ?').get('closing-user').username, 'closing-user')
    db.close()
  } finally { hook?.disable(); await app.close() }
})

it('does not apply an administrator mutation whose session was revoked during a slow body', async () => {
  const app = await fixture()
  let pending
  try {
    let admin = await login(app)
    const user = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'unchanged-user' } })
    assert.equal(user.status, 201)
    for (const operation of ['create', 'patch']) {
      const path = operation === 'create' ? '/users' : `/users/${user.body.user.id}`
      const body = operation === 'create' ? { username: 'revoked-create' } : { displayName: 'Should not change' }
      pending = await app.pendingJson(path, { method: operation === 'create' ? 'POST' : 'PATCH', cookie: admin.cookie, body })
      assert.equal((await app.request(`/users/${admin.body.user.id}/reset-password`, { method: 'POST', cookie: admin.cookie })).status, 204)
      assert.equal((await pending.finish()).status, 401)
      pending.cancel()
      pending = undefined
      admin = await login(app)
    }
    assert.equal((await app.request('/users?q=revoked-create', { cookie: admin.cookie })).body.total, 0)
    assert.equal((await app.request(`/users/${user.body.user.id}`, { cookie: admin.cookie })).body.user.displayName, '')
  } finally { pending?.cancel(); await app.close() }
})

it('does not fail a committed operation when a logger throws or rejects', async () => {
  let calls = 0
  const app = await fixture({
    logger: {
      info: () => {
        if (calls++ % 2 === 0) throw new Error('Logging transport failed')
        return Promise.reject(new Error('Logging transport failed'))
      },
      error: () => Promise.reject(new Error('Logging transport failed'))
    }
  })
  try {
    const admin = await login(app)
    assert.equal(admin.status, 200)
    const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'logger-safe-user' } })
    assert.equal(created.status, 201)
    assert.equal((await app.request(`/users/${created.body.user.id}`, { cookie: admin.cookie })).status, 200)
  } finally { await app.close() }
})

it('reports a sanitized database error code without query values in runtime logs or responses', async () => {
  const records = []
  const app = await fixture({ logger: { error: record => records.push(record) } })
  try {
    const admin = await login(app)
    const db = new DatabaseSync(app.databasePath)
    db.exec('DROP TABLE operation_logs')
    db.close()
    const response = await app.request('/logs?q=private-file-cid-marker', { cookie: admin.cookie })
    assert.equal(response.status, 500)
    assert.equal(response.body.error.code, 'INTERNAL_ERROR')
    assert.equal(records.length, 1)
    assert.equal(records[0].event, 'api_error')
    assert.equal(records[0].code, 'DATABASE_ERROR')
    assert.ok(records[0].dbCode)
    assert.equal(JSON.stringify({ records, response }).includes('private-file-cid-marker'), false)
    assert.equal(JSON.stringify(records).includes('SELECT'), false)
  } finally { await app.close() }
})
