import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it } from 'node:test'
import { fixture, login } from './fixtures.mjs'

const databases = JSON.parse(process.env.IFSHARE_TEST_DATABASES || '[]')

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

if (!databases.length) it('external database API integration (set IFSHARE_TEST_DATABASES to enable)', { skip: true }, () => {})

for (const settings of databases) {
  it(`${settings.databaseType}: initializes database and supports authentication, users and persistent operation logs`, async () => {
    const config = { ...settings, databaseName: 'ifshare_api_' + randomUUID().replaceAll('-', ''), databaseCreate: true }
    let app
    try {
      app = await fixture(config)
      const admin = await login(app)
      assert.equal(admin.status, 200)
      assert.equal(admin.body.user.role, 'admin')
      const create = body => app.request('/users', { method: 'POST', cookie: admin.cookie, body })
      const created = await create({ username: 'cross-db-user', displayName: '数据库用户' })
      assert.equal(created.status, 201)
      const id = created.body.user.id
      assert.equal(typeof id, 'number')
      assert.equal((await create({ username: 'CROSS-DB-USER' })).status, 409)
      const concurrent = await Promise.all([create({ username: 'concurrent-db-user' }), create({ username: 'CONCURRENT-DB-USER' })])
      assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409])
      const user = await login(app, 'CROSS-DB-USER')
      assert.equal(user.status, 200)
      assert.equal((await app.request('/users', { cookie: user.cookie })).status, 403)
      assert.equal((await app.request(`/users/${id}`, { cookie: admin.cookie })).body.user.displayName, '数据库用户')
      assert.equal((await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { displayName: 'Updated' } })).status, 200)
      assert.equal((await app.request('/users?q=Updated', { cookie: admin.cookie })).body.total, 1)
      const payload = { eventId: randomUUID(), action: 'preview', fileName: '100%_ready!.txt', filePath: '/preview', cid: '', fileCount: 1 }
      const write = (session, body) => app.request('/logs', { method: 'POST', cookie: session.cookie, body })
      const events = await Promise.all([write(user, payload), write(user, payload)])
      assert.deepEqual(events.map(response => response.status).sort(), [200, 201])
      assert.deepEqual(events[0].body.log, events[1].body.log)
      const original = events[0].body.log
      assert.equal(typeof original.id, 'number')
      assert.equal(typeof original.userId, 'number')
      assert.equal(typeof original.fileCount, 'number')
      assert.equal((await write(admin, { ...payload, eventId: randomUUID(), action: 'download' })).status, 201)
      const scoped = await app.request('/logs', { cookie: user.cookie })
      assert.equal(scoped.body.total, 1)
      assert.deepEqual(scoped.body.logs, [original])
      const page = await app.request('/logs?page=2&pageSize=1', { cookie: admin.cookie })
      assert.equal(page.body.total, 2)
      assert.deepEqual(page.body.logs, [original])
      assert.equal((await app.request('/logs?action=preview&q=%25_', { cookie: admin.cookie })).body.total, 1)
      assert.equal((await app.request('/logs?q=' + encodeURIComponent("' OR 1=1--"), { cookie: admin.cookie })).body.total, 0)
      await app.restart()
      assert.deepEqual((await app.request('/logs', { cookie: user.cookie })).body.logs, [original])
      const pending = await app.pendingJson('/logs', { cookie: user.cookie, body: { ...payload, eventId: randomUUID() } })
      try {
        assert.equal((await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { enabled: false } })).status, 200)
        assert.equal((await pending.finish()).status, 401)
      } finally { pending.cancel() }
      assert.equal((await app.request('/logs', { cookie: user.cookie })).status, 401)
      assert.equal((await login(app, 'cross-db-user')).status, 401)
      assert.equal((await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { enabled: true } })).status, 200)
      const enabled = await login(app, 'cross-db-user')
      assert.equal(enabled.status, 200)
      assert.equal((await app.request(`/users/${id}/reset-password`, { method: 'POST', cookie: admin.cookie })).status, 204)
      assert.equal((await app.request('/auth/session', { cookie: enabled.cookie })).status, 401)
      assert.equal((await login(app, 'cross-db-user')).status, 200)
      assert.equal((await app.request(`/users/${id}`, { method: 'DELETE', cookie: admin.cookie })).status, 204)
      assert.equal((await app.request(`/users/${id}`, { cookie: admin.cookie })).status, 404)
      assert.equal((await app.request('/logs?action=preview', { cookie: admin.cookie })).body.total, 1)
      assert.equal((await create({ username: 'cross-db-user' })).status, 201)
      const replacement = await login(app, 'cross-db-user')
      assert.notEqual(replacement.body.user.id, id)
      assert.equal((await app.request('/logs', { cookie: replacement.cookie })).body.total, 0)
    } finally {
      await app?.close()
      await dropDatabase(config)
    }
  })
}
