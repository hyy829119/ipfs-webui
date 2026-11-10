import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fixture, login } from './fixtures.mjs'

function event (overrides = {}) {
  return { eventId: randomUUID(), action: 'upload', fileName: 'report.txt', filePath: '/reports/report.txt', cid: 'bafy-test-file', fileCount: 1, ...overrides }
}

describe('persistent, scoped file operation logs', () => {
  let app
  let admin
  let alice
  let bob

  async function createUser (username) {
    const result = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username } })
    assert.equal(result.status, 201)
    const session = await login(app, username)
    assert.equal(session.status, 200)
    return session
  }

  async function write (session, payload = event()) {
    return app.request('/logs', { method: 'POST', cookie: session.cookie, body: payload })
  }

  before(async () => {
    app = await fixture()
    admin = await login(app)
    alice = await createUser('alice-logs')
    bob = await createUser('bob-logs')
  })
  after(async () => { await app?.close() })

  it('requires login, same-origin and mutation headers; never accepts client identity or timestamps', async () => {
    assert.equal((await app.request('/logs')).status, 401)
    assert.equal((await app.request('/logs', { method: 'POST', body: event() })).status, 401)
    for (const headers of [{ Origin: 'https://untrusted.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-IFShare-Request': '' }]) {
      assert.equal((await app.request('/logs', { method: 'POST', cookie: alice.cookie, body: event(), headers })).status, 403)
    }
    for (const field of ['userId', 'username', 'createdAt', 'ip', 'password', 'content']) {
      const result = await write(alice, event({ [field]: 'forged' }))
      assert.equal(result.status, 400)
      assert.equal(result.body.error.code, 'INVALID_FIELDS')
    }
    assert.equal((await app.request('/logs', { method: 'DELETE', cookie: admin.cookie })).status, 405)
    assert.equal((await app.request('/logs/1', { method: 'PATCH', cookie: admin.cookie, body: {} })).status, 404)
  })

  it('records all three initiated operations with server-generated identity, time and bounded metadata', async () => {
    for (const action of ['upload', 'download', 'preview']) {
      const payload = event({ action, fileCount: action === 'download' ? 3 : 1 })
      const before = Date.now()
      const result = await write(alice, payload)
      assert.equal(result.status, 201)
      const { log } = result.body
      assert.ok(log.id > 0)
      assert.equal(log.userId, alice.body.user.id)
      assert.equal(log.username, 'alice-logs')
      assert.ok(Date.parse(log.createdAt) >= before)
      for (const field of Object.keys(payload)) assert.equal(log[field], payload[field])
      assert.deepEqual(Object.keys(log).sort(), ['id', 'userId', 'username', 'eventId', 'action', 'fileName', 'filePath', 'cid', 'fileCount', 'createdAt'].sort())
    }
  })

  it('forces ordinary users to their own history even when other user IDs are supplied', async () => {
    const bobEntry = await write(bob, event({ fileName: 'bob-private.txt' }))
    assert.equal(bobEntry.status, 201)
    const own = await app.request(`/logs?userId=${bob.body.user.id}`, { cookie: alice.cookie })
    assert.equal(own.status, 200)
    assert.ok(own.body.logs.length >= 3)
    assert.ok(own.body.logs.every(log => log.userId === alice.body.user.id))
    assert.equal((await app.request('/logs?q=bob-private', { cookie: alice.cookie })).body.total, 0)
    const all = await app.request('/logs', { cookie: admin.cookie })
    assert.ok(all.body.logs.some(log => log.userId === bob.body.user.id))
    assert.ok(all.body.logs.some(log => log.userId === alice.body.user.id))
  })

  it('provides stable descending pages and combined action/search filters across all metadata', async () => {
    const first = await app.request('/logs?page=1&pageSize=2', { cookie: admin.cookie })
    const second = await app.request('/logs?page=2&pageSize=2', { cookie: admin.cookie })
    assert.equal(first.body.logs.length, 2)
    assert.equal(second.body.logs.length, 2)
    assert.equal(first.body.total, second.body.total)
    assert.equal(first.body.page, 1)
    assert.equal(first.body.pageSize, 2)
    assert.ok(first.body.logs[0].id > first.body.logs[1].id)
    assert.ok(first.body.logs[1].id > second.body.logs[0].id)
    const payload = event({ action: 'preview', fileName: 'UniquePicture.PNG', filePath: '/unique-location/picture', cid: 'bafy-unique-cid' })
    const created = (await write(bob, payload)).body.log
    for (const q of ['uniquepicture', 'unique-location', 'unique-cid', 'BOB-LOGS']) {
      const result = await app.request(`/logs?q=${q}&action=preview`, { cookie: admin.cookie })
      assert.equal(result.body.total, 1)
      assert.equal(result.body.logs[0].id, created.id)
    }
    assert.equal((await app.request('/logs?q=UniquePicture&action=download', { cookie: admin.cookie })).body.total, 0)
    assert.equal((await app.request('/logs?page=9999', { cookie: admin.cookie })).body.logs.length, 0)
  })

  it('keeps retries idempotent, including concurrent submissions and different payloads for the same event', async () => {
    const payload = event({ fileName: 'retry.txt' })
    const results = await Promise.all(Array.from({ length: 4 }, () => write(alice, payload)))
    assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 200, 201])
    assert.equal(new Set(results.map(result => result.body.log.id)).size, 1)
    const retry = await write(alice, { ...payload, eventId: payload.eventId.toUpperCase(), fileName: 'changed.txt', action: 'download' })
    assert.equal(retry.status, 200)
    assert.deepEqual(retry.body.log, results[0].body.log)
    assert.equal((await app.request('/logs?q=retry.txt', { cookie: alice.cookie })).body.total, 1)
    const other = await write(bob, payload)
    assert.equal(other.status, 201)
    assert.notEqual(other.body.log.id, retry.body.log.id)
  })

  it('validates supported fields, metadata lengths, UUIDs, actions, counts and query limits', async () => {
    for (const overrides of [
      { eventId: 'invalid' }, { action: 'delete' }, { action: ['upload'] }, { fileCount: 0 }, { fileCount: 1.5 },
      { fileCount: 1_000_001 }, { fileCount: '1' }, { fileName: null }, { fileName: 'a'.repeat(257) },
      { filePath: 'a'.repeat(1025) }, { cid: 'a'.repeat(257) }, { fileName: 'bad\u0000name' }
    ]) {
      const result = await write(alice, event(overrides))
      assert.equal(result.status, 400, JSON.stringify(overrides))
      assert.equal(result.body.error.code, 'INVALID_FIELDS')
    }
    assert.equal((await write(alice, event({ fileName: 'a'.repeat(9000) }))).status, 413)
    for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1000001', 'page=NaN', 'pageSize=0', 'pageSize=101', 'action=delete', 'q=' + 'a'.repeat(129)]) {
      const result = await app.request('/logs?' + query, { cookie: admin.cookie })
      assert.equal(result.status, 400, query)
      assert.equal(result.body.error.code, 'INVALID_QUERY')
    }
    assert.equal((await write(alice, event({ fileName: 'a'.repeat(256), filePath: 'a'.repeat(1024), cid: 'a'.repeat(256), fileCount: 1_000_000 }))).status, 201)
    assert.equal((await write(alice, event({ filePath: '', cid: '' }))).status, 201)
  })

  it('treats SQL and LIKE wildcard characters in filenames and searches literally', async () => {
    const name = "100%_ready! ' OR 1=1--.txt"
    const created = await write(alice, event({ fileName: name, filePath: '/literal/' + name }))
    assert.equal(created.status, 201)
    for (const q of ['%', '_', '!', "' OR 1=1--"]) {
      const result = await app.request('/logs?q=' + encodeURIComponent(q), { cookie: alice.cookie })
      assert.equal(result.body.total, 1)
      assert.equal(result.body.logs[0].id, created.body.log.id)
    }
    assert.equal((await app.request('/logs?q=' + encodeURIComponent("x' UNION SELECT * FROM users--"), { cookie: admin.cookie })).body.total, 0)
    assert.equal((await app.request('/users', { cookie: admin.cookie })).status, 200)
  })

  it('preserves history across restart and user deletion without exposing it to a reused username', async () => {
    const oldUser = await createUser('reusable-logs')
    const payload = event({ fileName: 'preserved-history.txt' })
    const created = await write(oldUser, payload)
    await app.restart()
    const persisted = await app.request('/logs?q=preserved-history', { cookie: oldUser.cookie })
    assert.deepEqual(persisted.body.logs, [created.body.log])
    assert.equal((await write(oldUser, payload)).status, 200)
    assert.equal((await app.request(`/users/${oldUser.body.user.id}`, { method: 'DELETE', cookie: admin.cookie })).status, 204)
    assert.equal((await app.request('/logs', { cookie: oldUser.cookie })).status, 401)
    assert.deepEqual((await app.request('/logs?q=preserved-history', { cookie: admin.cookie })).body.logs, [created.body.log])
    const newUser = await createUser('reusable-logs')
    assert.notEqual(newUser.body.user.id, oldUser.body.user.id)
    assert.equal((await app.request('/logs', { cookie: newUser.cookie })).body.total, 0)
    assert.equal((await app.request('/logs?q=reusable-logs', { cookie: admin.cookie })).body.total, 1)
  })

  it('rejects logging after an account is disabled', async () => {
    const user = await createUser('disabled-logs')
    await write(user)
    assert.equal((await app.request(`/users/${user.body.user.id}`, { method: 'PATCH', cookie: admin.cookie, body: { enabled: false } })).status, 200)
    assert.equal((await write(user)).status, 401)
    assert.equal((await app.request('/logs', { cookie: user.cookie })).status, 401)
  })

  it('rechecks log ownership after a slow body when an account is disabled, renamed, reset or deleted', async () => {
    for (const operation of ['disable', 'rename', 'reset', 'delete']) {
      const user = await createUser('slow-log-' + operation)
      const payload = event({ fileName: 'rejected-' + operation + '.txt' })
      const pending = await app.pendingJson('/logs', { cookie: user.cookie, body: payload })
      try {
        const path = `/users/${user.body.user.id}${operation === 'reset' ? '/reset-password' : ''}`
        const method = operation === 'delete' ? 'DELETE' : operation === 'reset' ? 'POST' : 'PATCH'
        const body = operation === 'disable' ? { enabled: false } : operation === 'rename' ? { username: 'renamed-slow-log' } : undefined
        const changed = await app.request(path, { method, cookie: admin.cookie, body })
        assert.ok([200, 204].includes(changed.status), operation)
        const result = await pending.finish()
        assert.equal(result.status, 401, operation)
        assert.equal((await app.request('/logs?q=' + encodeURIComponent(payload.fileName), { cookie: admin.cookie })).body.total, 0)
      } finally { pending.cancel() }
    }
  })

  it('limits new events per user while allowing idempotent retries and another user to continue', async () => {
    const user = await createUser('limited-logs')
    const payload = event()
    const now = Date.now
    const instant = now()
    try {
      Date.now = () => instant
      assert.equal((await write(user, payload)).status, 201)
      for (let count = 1; count < 600; count++) assert.equal((await write(user)).status, 201)
      const limited = await write(user)
      assert.equal(limited.status, 429)
      assert.equal(Number(limited.headers.get('retry-after')), 60)
      assert.equal((await write(user, payload)).status, 200)
      assert.equal((await write(bob)).status, 201)
      Date.now = () => instant + 60_001
      assert.equal((await write(user)).status, 201)
    } finally { Date.now = now }
  })
})
