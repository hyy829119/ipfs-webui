import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { createApi } from '../api.mjs'
import { encryptedLogin, fixture, login } from './fixtures.mjs'

const PREFIX = '/webui-api/v1'

describe('SQLite-backed encrypted authentication and administrator API', () => {
  let app
  let admin
  before(async () => {
    app = await fixture()
    admin = await login(app)
    assert.equal(admin.status, 200)
  })
  after(async () => { await app?.close() })

  it('initializes admin/password, sets protected cookies, and never returns password material', async () => {
    assert.equal(admin.body.user.username, 'admin')
    assert.equal(admin.body.user.role, 'admin')
    assert.equal(admin.body.user.enabled, true)
    assert.ok(admin.body.user.lastLoginAt)
    assert.match(admin.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800/)
    assert.equal(admin.headers.get('cache-control'), 'no-store')
    assert.equal('password_hash' in admin.body.user, false)
    assert.equal('password' in admin.body.user, false)
    assert.equal((await app.request('/auth/session', { cookie: admin.cookie })).body.user.id, admin.body.user.id)
    assert.equal((await app.request('/auth/session')).status, 401)
    assert.equal((await app.request('/users')).status, 401)
  })

  it('rejects plaintext, malformed encryption, replay, and a changed username binding', async () => {
    const plaintext = await encryptedLogin(app)
    plaintext.password = 'password'
    assert.equal((await app.request('/auth/login', { method: 'POST', body: plaintext })).status, 400)
    const request = await encryptedLogin(app)
    assert.equal((await app.request('/auth/login', { method: 'POST', body: request })).status, 200)
    assert.equal((await app.request('/auth/login', { method: 'POST', body: request })).body.error.code, 'INVALID_CHALLENGE')
    const renamed = await encryptedLogin(app)
    renamed.username = 'other-user'
    assert.equal((await app.request('/auth/login', { method: 'POST', body: renamed })).body.error.code, 'INVALID_CREDENTIAL_PAYLOAD')
  })

  it('uses indistinguishable login failures for an unknown user and a wrong password', async () => {
    const wrong = await login(app, 'admin', '123456')
    const unknown = await login(app, 'missing-user', 'password')
    assert.equal(wrong.status, 401)
    assert.equal(unknown.status, 401)
    assert.deepEqual(wrong.body, unknown.body)
  })

  it('expires login challenges after two minutes', async () => {
    const request = await encryptedLogin(app)
    const now = Date.now
    try {
      Date.now = () => now() + 121_000
      const result = await app.request('/auth/login', { method: 'POST', body: request })
      assert.equal(result.status, 400)
      assert.equal(result.body.error.code, 'INVALID_CHALLENGE')
    } finally { Date.now = now }
  })

  it('rejects oversized request bodies and non-JSON input before processing credentials', async () => {
    assert.equal((await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'large-user', displayName: 'x'.repeat(9000) } })).status, 413)
    assert.equal((await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'plain-user' }, headers: { 'Content-Type': 'text/plain' } })).status, 415)
    const result = await fetch(app.origin + PREFIX + '/users', { method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json', 'X-IFShare-Request': '1' }, body: '{broken' })
    assert.equal(result.status, 400)
    await result.body.cancel()
  })

  it('rejects cross-origin requests, missing mutation headers, and role or password injection', async () => {
    for (const headers of [{ Origin: 'https://untrusted.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-IFShare-Request': '' }]) {
      const result = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'blocked' }, headers })
      assert.equal(result.status, 403)
    }
    for (const field of ['role', 'password', 'password_hash']) {
      assert.equal((await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'injected', [field]: 'admin' } })).status, 400)
    }
    assert.equal((await app.request('/users', { cookie: admin.cookie, headers: { Origin: 'https://untrusted.invalid' } })).status, 403)
  })

  it('supports create/detail/update/search/page/delete and enforces case-insensitive uniqueness', async () => {
    const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'demo-user', displayName: '测试成员' } })
    assert.equal(created.status, 201)
    const id = created.body.user.id
    assert.equal(created.body.user.role, 'user')
    assert.equal(created.body.user.enabled, true)
    assert.equal((await app.request(`/users/${id}`, { cookie: admin.cookie })).body.user.displayName, '测试成员')
    assert.equal((await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'DEMO-USER' } })).status, 409)
    const userLogin = await login(app, 'demo-user')
    assert.equal(userLogin.status, 200)
    const updated = await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { username: 'renamed-user', displayName: '新的名称' } })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.user.username, 'renamed-user')
    assert.equal((await app.request('/auth/session', { cookie: userLogin.cookie })).status, 401)
    const listed = await app.request('/users?q=renamed&page=1&pageSize=1', { cookie: admin.cookie })
    assert.equal(listed.body.total, 1)
    assert.equal(listed.body.pageSize, 1)
    assert.equal(listed.body.users[0].id, id)
    assert.equal((await app.request(`/users/${id}`, { method: 'DELETE', cookie: admin.cookie })).status, 204)
    assert.equal((await app.request(`/users/${id}`, { cookie: admin.cookie })).status, 404)
  })

  it('prevents every user-management operation for a non-admin, including self-edit', async () => {
    const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'regular-user' } })
    const user = await login(app, 'regular-user')
    const id = created.body.user.id
    assert.equal(user.body.user.role, 'user')
    const operations = [
      ['/users', 'GET'], [`/users/${id}`, 'GET'], ['/users', 'POST'],
      [`/users/${id}`, 'PATCH'], [`/users/${id}`, 'DELETE'], [`/users/${id}/reset-password`, 'POST']
    ]
    for (const [path, method] of operations) {
      const result = await app.request(path, { method, cookie: user.cookie, ...(method === 'POST' || method === 'PATCH' ? { body: { username: 'admin' } } : {}) })
      assert.equal(result.status, 403, `${method} ${path}`)
    }
  })

  it('serializes concurrent duplicate user creation without returning an internal error', async () => {
    const responses = await Promise.all([1, 2].map(() => app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'concurrent-user' } })))
    assert.deepEqual(responses.map(result => result.status).sort(), [201, 409])
  })

  it('revokes existing sessions on disable and allows login again only after re-enabling', async () => {
    const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'toggle-user' } })
    const id = created.body.user.id
    const user = await login(app, 'toggle-user')
    assert.equal(user.status, 200)
    assert.equal((await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { enabled: false } })).status, 200)
    assert.equal((await app.request('/auth/session', { cookie: user.cookie })).status, 401)
    assert.equal((await login(app, 'toggle-user')).status, 401)
    assert.equal((await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { enabled: true } })).status, 200)
    assert.equal((await login(app, 'toggle-user')).status, 200)
    assert.equal((await app.request('/auth/session', { cookie: user.cookie })).status, 401)
  })

  it('resets passwords to password with a fresh hash and revokes all prior sessions', async () => {
    const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'reset-user' } })
    const id = created.body.user.id
    const first = await login(app, 'reset-user')
    const second = await login(app, 'reset-user')
    const db = new DatabaseSync(app.databasePath)
    const oldHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash
    assert.equal((await app.request(`/users/${id}/reset-password`, { method: 'POST', cookie: admin.cookie })).status, 204)
    const newHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash
    db.close()
    assert.notEqual(oldHash, newHash)
    assert.match(newHash, /^scrypt\$/)
    assert.equal((await app.request('/auth/session', { cookie: first.cookie })).status, 401)
    assert.equal((await app.request('/auth/session', { cookie: second.cookie })).status, 401)
    assert.equal((await login(app, 'reset-user')).status, 200)
  })

  it('deletes sessions with a deleted user and rejects their future logins', async () => {
    const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'delete-user' } })
    const user = await login(app, 'delete-user')
    assert.equal((await app.request(`/users/${created.body.user.id}`, { method: 'DELETE', cookie: admin.cookie })).status, 204)
    assert.equal((await app.request('/auth/session', { cookie: user.cookie })).status, 401)
    assert.equal((await login(app, 'delete-user')).status, 401)
  })

  it('protects the builtin administrator from disable, deletion, rename, and role changes', async () => {
    const id = admin.body.user.id
    for (const body of [{ enabled: false }, { username: 'new-admin' }, { role: 'user' }]) {
      assert.equal((await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body })).status, 400)
    }
    assert.equal((await app.request(`/users/${id}`, { method: 'DELETE', cookie: admin.cookie })).status, 400)
    assert.equal((await app.request(`/users/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { displayName: '负责人' } })).status, 200)
  })

  it('validates identifiers, fields, pagination, and treats search input as literal SQL data', async () => {
    for (const body of [{ username: "x' OR 1=1--" }, { username: 'ab' }, { username: 'good-name', enabled: 'false' }, { username: 'good-name', displayName: 'x'.repeat(65) }, { username: 'good-name', displayName: '\u0000' }]) {
      assert.equal((await app.request('/users', { method: 'POST', cookie: admin.cookie, body })).status, 400)
    }
    for (const q of ["' OR 1=1--", '%', '_']) {
      assert.equal((await app.request(`/users?q=${encodeURIComponent(q)}`, { cookie: admin.cookie })).body.total, 0)
    }
    for (const query of ['page=0', 'page=NaN', 'pageSize=101', 'page=1.5', 'q=' + 'a'.repeat(65)]) {
      assert.equal((await app.request('/users?' + query, { cookie: admin.cookie })).status, 400)
    }
    assert.equal((await app.request('/users/9007199254740992', { cookie: admin.cookie })).status, 404)
  })

  it('logs out on the server and rejects forged or duplicated session cookies', async () => {
    const user = await login(app, 'regular-user')
    assert.equal((await app.request('/auth/session', { cookie: `${user.cookie}; ${user.cookie}` })).status, 401)
    assert.equal((await app.request('/auth/session', { cookie: 'ifshare_session=' + 'a'.repeat(64) })).status, 401)
    const result = await app.request('/auth/logout', { method: 'POST', cookie: user.cookie })
    assert.equal(result.status, 204)
    assert.match(result.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal((await app.request('/auth/session', { cookie: user.cookie })).status, 401)
  })

  it('persists users and valid sessions across restart without resetting admin or stored hashes', async () => {
    const db = new DatabaseSync(app.databasePath)
    const before = db.prepare('SELECT id, password_hash FROM users ORDER BY id').all()
    assert.ok(before.every(row => row.password_hash.startsWith('scrypt$')))
    assert.equal(new Set(before.map(row => row.password_hash)).size, before.length)
    assert.equal(db.prepare('SELECT token_hash FROM sessions').all().some(row => admin.cookie.includes(row.token_hash)), false)
    db.close()
    await app.restart()
    assert.equal((await app.request('/auth/session', { cookie: admin.cookie })).status, 200)
    const reopened = new DatabaseSync(app.databasePath)
    assert.deepEqual(reopened.prepare('SELECT id, password_hash FROM users ORDER BY id').all(), before)
    reopened.close()
    if (process.platform !== 'win32') assert.equal((await stat(app.databasePath)).mode & 0o777, 0o600)
    assert.ok((await readFile(app.databasePath)).subarray(0, 16).toString().startsWith('SQLite format 3'))
  })

  it('enforces server-side session expiry', async () => {
    const user = await login(app, 'regular-user')
    const db = new DatabaseSync(app.databasePath)
    db.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(user.body.user.id)
    db.close()
    assert.equal((await app.request('/auth/session', { cookie: user.cookie })).status, 401)
  })

  it('keeps at most sixteen recent sessions per user', async () => {
    const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username: 'many-sessions-user' } })
    assert.equal(created.status, 201)
    const sessions = []
    for (let index = 0; index < 18; index++) {
      const result = await login(app, 'many-sessions-user')
      assert.equal(result.status, 200)
      sessions.push(result)
    }
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => login(app, 'many-sessions-user')))
    for (const result of concurrent) assert.equal(result.status, 200)
    const db = new DatabaseSync(app.databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(created.body.user.id).count, 16)
    db.close()
    assert.equal((await app.request('/auth/session', { cookie: sessions[0].cookie })).status, 401)
    assert.equal((await app.request('/auth/session', { cookie: sessions.at(-1).cookie })).status, 200)
  })

  it('never leaves a usable session after a concurrent disable, password reset or deletion', async () => {
    for (const operation of ['disable', 'reset', 'delete']) {
      const username = 'login-race-' + operation
      const created = await app.request('/users', { method: 'POST', cookie: admin.cookie, body: { username } })
      assert.equal(created.status, 201)
      const id = created.body.user.id
      if (operation === 'reset') {
        const salt = '102030405060708090a0b0c0d0e0f000'
        const hash = scryptSync('old-secret', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')
        const db = new DatabaseSync(app.databasePath)
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(`scrypt$32768$8$1$${salt}$${hash}`, id)
        db.close()
      }
      const body = await encryptedLogin(app, username, operation === 'reset' ? 'old-secret' : 'password')
      const changed = { method: operation === 'disable' ? 'PATCH' : operation === 'reset' ? 'POST' : 'DELETE', cookie: admin.cookie }
      if (operation === 'disable') changed.body = { enabled: false }
      const [session, mutation] = await Promise.all([
        app.request('/auth/login', { method: 'POST', body }),
        app.request(`/users/${id}${operation === 'reset' ? '/reset-password' : ''}`, changed)
      ])
      assert.ok([200, 204].includes(mutation.status), operation)
      assert.ok([200, 401].includes(session.status), operation)
      if (session.status === 200) assert.equal((await app.request('/auth/session', { cookie: session.cookie })).status, 401, operation)
    }
  })

  it('bounds failed login attempts per username', async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await app.request('/auth/login', { method: 'POST', body: { username: 'rate-limit-user', challengeId: 'invalid', password: 'invalid' } })
      assert.equal(result.status, 400)
    }
    const limited = await app.request('/auth/login', { method: 'POST', body: { username: 'rate-limit-user', challengeId: 'invalid', password: 'invalid' } })
    assert.equal(limited.status, 429)
    assert.ok(limited.headers.get('retry-after'))
  })
})

it('uses Secure cookies and explicit public origin behind HTTPS', async () => {
  const app = await fixture({ publicOrigin: 'https://files.example.test', secureCookies: true })
  try {
    const user = await login(app)
    assert.equal(user.status, 200)
    assert.match(user.headers.get('set-cookie'), /; Secure/)
    assert.equal((await app.request('/auth/session', { cookie: user.cookie, headers: { Origin: app.origin } })).status, 403)
  } finally { await app.close() }
})

it('initializes exactly one administrator during concurrent service startup and exposes async authentication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifshare-api-startup-'))
  const databasePath = join(directory, 'users.sqlite')
  const instances = []
  try {
    const results = await Promise.allSettled(Array.from({ length: 2 }, async () => {
      const api = await createApi({ databasePath })
      instances.push(api)
      return api
    }))
    for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message)
    const authentication = instances[0].authenticate({ headers: {} })
    assert.ok(authentication instanceof Promise)
    assert.equal(await authentication, null)
    const db = new DatabaseSync(databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1)
    assert.equal(db.prepare('SELECT username FROM users').get().username, 'admin')
    db.close()
  } finally {
    await Promise.all(instances.map(api => api.close()))
    await rm(directory, { recursive: true, force: true })
  }
})
