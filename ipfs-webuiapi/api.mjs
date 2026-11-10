import { createHash, generateKeyPair, privateDecrypt, randomBytes, scrypt, timingSafeEqual, constants } from 'node:crypto'
import { promisify, TextDecoder } from 'node:util'
import { isUniqueViolation, openDatabase } from './database.mjs'

const generateKeyPairAsync = promisify(generateKeyPair)
const scryptAsync = promisify(scrypt)
const PREFIX = '/webui-api/v1'
const COOKIE = 'ifshare_session'
const SESSION_MS = 8 * 60 * 60 * 1000
const CHALLENGE_MS = 2 * 60 * 1000
const BODY_LIMIT = 8192
const BODY_TIMEOUT_MS = 15_000
const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOG_ACTIONS = ['upload', 'download', 'preview']
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function fail (status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

export function assertSameOrigin (req, publicOrigin = '') {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'ORIGIN_REJECTED', '请求来源不受信任')
  const origin = req.headers.origin
  if (!origin) return
  let parsed
  try { parsed = new URL(origin) } catch { throw fail(403, 'ORIGIN_REJECTED', '请求来源不受信任') }
  const matches = publicOrigin ? origin === publicOrigin : parsed.host === req.headers.host
  if (!matches || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
    throw fail(403, 'ORIGIN_REJECTED', '请求来源不受信任')
  }
}

function send (res, status, value) {
  const request = res.req
  if (request && !request.complete && (Number(request.headers['content-length']) > 0 || request.headers['transfer-encoding'])) {
    res.shouldKeepAlive = false
    res.setHeader('Connection', 'close')
    request.resume()
  }
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (value === undefined) return res.end()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

async function jsonBody (req, timeoutMs, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'JSON_REQUIRED', '请使用 JSON 请求')
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    req.resume()
    throw fail(413, 'BODY_TOO_LARGE', '请求内容过大')
  }
  let bytes = 0
  const chunks = []
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      if (error) { req.resume(); reject(error) } else resolve()
    }
    const onData = (chunk) => {
      bytes += chunk.length
      if (bytes > BODY_LIMIT) return finish(fail(413, 'BODY_TOO_LARGE', '请求内容过大'))
      chunks.push(chunk)
    }
    const onEnd = () => finish()
    const onError = () => finish(fail(400, 'BODY_INTERRUPTED', '请求内容传输中断'))
    const onAborted = () => finish(fail(400, 'BODY_INTERRUPTED', '请求内容传输中断'))
    const onAbort = () => finish(signal.reason)
    const timeout = setTimeout(() => finish(fail(408, 'REQUEST_TIMEOUT', '请求内容传输超时，请重试')), timeoutMs)
    timeout.unref()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) { onAbort(); return }
    req.on('data', onData).once('end', onEnd).once('error', onError).once('aborted', onAborted)
  })
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Invalid object')
    return body
  } catch { throw fail(400, 'INVALID_JSON', '请求内容必须是有效 JSON 对象') }
}

function allowFields (body, fields) {
  if (Object.keys(body).some(field => !fields.includes(field))) throw fail(400, 'INVALID_FIELDS', '请求包含不支持的字段')
}

function validateUsername (value) {
  if (typeof value !== 'string' || !USERNAME.test(value)) throw fail(400, 'INVALID_USERNAME', '用户名需要 3–32 位字母、数字、点、下划线或短横线')
  return value
}

function validateDisplayName (value) {
  if (typeof value !== 'string' || value.length > 64 || /[\x00-\x1f\x7f]/.test(value)) throw fail(400, 'INVALID_DISPLAY_NAME', '显示名称最多 64 个字符，不能包含控制字符') // eslint-disable-line no-control-regex
  return value.trim()
}

function validateEnabled (value) {
  if (typeof value !== 'boolean') throw fail(400, 'INVALID_ENABLED', '启用状态必须是布尔值')
  return value
}

function publicUser (row) {
  if (!row) return null
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at, lastLoginAt: row.last_login_at }
}

function publicLog (row) {
  return { id: row.id, userId: row.user_id, username: row.username, eventId: row.event_id, action: row.action, fileName: row.file_name, filePath: row.file_path, cid: row.cid, fileCount: row.file_count, createdAt: row.created_at }
}

function searchPattern (value) {
  return '%' + value.replace(/[!%_]/g, '!$&') + '%'
}

function pagination (url, maximumQueryLength) {
  const rawQuery = url.searchParams.get('q') || ''
  const q = rawQuery.trim()
  const page = Number(url.searchParams.get('page') || 1)
  const pageSize = Number(url.searchParams.get('pageSize') || 20)
  if (rawQuery.length > maximumQueryLength || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw fail(400, 'INVALID_QUERY', '查询参数无效')
  return { q, page, pageSize }
}

function validateLog (body) {
  allowFields(body, ['eventId', 'action', 'fileName', 'filePath', 'cid', 'fileCount'])
  if (typeof body.eventId !== 'string' || !EVENT_ID.test(body.eventId) || !LOG_ACTIONS.includes(body.action) || !Number.isInteger(body.fileCount) || body.fileCount < 1 || body.fileCount > 1_000_000) throw fail(400, 'INVALID_FIELDS', '操作日志字段无效')
  for (const [field, maximum] of [['fileName', 256], ['filePath', 1024], ['cid', 256]]) {
    if (typeof body[field] !== 'string' || body[field].length > maximum || /[\x00-\x1f\x7f]/.test(body[field])) throw fail(400, 'INVALID_FIELDS', '操作日志字段无效') // eslint-disable-line no-control-regex
  }
  return { ...body, eventId: body.eventId.toLowerCase() }
}

function tokenHash (token) {
  return createHash('sha256').update(token).digest('hex')
}

function readToken (req) {
  const tokens = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='))
  if (tokens.length !== 1) return null
  const value = tokens[0].slice(COOKIE.length + 1)
  return /^[a-f0-9]{64}$/.test(value) ? value : null
}

/** Owns the configured database and in-memory login challenges. Await close() on shutdown. */
export async function createApi (options) {
  const { database, publicOrigin = '', secureCookies = false, logger = {}, bodyTimeoutMs = BODY_TIMEOUT_MS } = options
  if (!Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 120_000) throw new Error('bodyTimeoutMs must be between 1 and 120000')
  if (publicOrigin && (!['http:', 'https:'].includes(new URL(publicOrigin).protocol) || new URL(publicOrigin).origin !== publicOrigin)) throw new Error('publicOrigin must be an HTTP(S) origin without a path')
  const db = await openDatabase(database || options)
  const challenges = new Map()
  const limits = new Map()
  const active = new Set()
  const bodyReaders = new Set()
  let closed = false
  let closing
  let activeHashes = 0

  function emit (level, value) {
    // Logging failures must never turn a committed operation into a failed response.
    try { Promise.resolve(logger[level]?.(value)).catch(() => {}) } catch {}
  }

  function track (operation) {
    active.add(operation)
    operation.then(() => active.delete(operation), () => active.delete(operation))
    return operation
  }

  function unavailable () { return fail(503, 'SERVICE_UNAVAILABLE', '服务正在关闭，请稍后重试') }

  async function readBody (req) {
    if (closed) throw unavailable()
    const controller = new AbortController()
    bodyReaders.add(controller)
    try { return await jsonBody(req, bodyTimeoutMs, controller.signal) } finally { bodyReaders.delete(controller) }
  }

  async function derive (password, salt) {
    if (activeHashes >= 8) throw fail(503, 'AUTH_BUSY', '登录服务繁忙，请稍后重试')
    activeHashes++
    try { return await scryptAsync(password, salt, 64, PASSWORD_OPTIONS) } finally { activeHashes-- }
  }

  async function hashPassword (password) {
    const salt = randomBytes(16).toString('hex')
    return `scrypt$32768$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`
  }

  async function verifyPassword (password, stored) {
    const [algorithm, n, r, p, salt, hash] = stored.split('$')
    if (algorithm !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hash || '')) return false
    return timingSafeEqual(await derive(password, salt), Buffer.from(hash, 'hex'))
  }

  let privateKey
  let publicKey
  let dummyPassword
  try {
    const pair = await generateKeyPairAsync('rsa', { modulusLength: 3072 })
    privateKey = pair.privateKey
    publicKey = pair.publicKey.export({ format: 'jwk' })
    dummyPassword = await hashPassword(randomBytes(32).toString('hex'))
    if (!Number((await db.get('SELECT COUNT(*) AS count FROM users')).count)) {
      const hash = await hashPassword('password')
      const now = new Date().toISOString()
      try {
        await db.run("INSERT INTO users (username, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, 'admin', 1, ?, ?)", ['admin', '管理员', hash, now, now])
      } catch (error) {
        if (!isUniqueViolation(error) || !(await db.get("SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND role = 'admin'", ['admin']))) throw error
      }
    }
  } catch (err) {
    await db.close()
    throw err
  }

  async function clean () {
    const now = Date.now()
    for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key)
    for (const [key, value] of limits) if (value.expiresAt <= now) limits.delete(key)
    await db.run('DELETE FROM sessions WHERE expires_at <= ?', [now])
  }
  let cleaning
  const cleanup = setInterval(() => {
    if (closed || cleaning) return
    cleaning = clean().catch(error => {
      emit('error', { event: 'session_cleanup_failed', code: error.code || 'UNKNOWN', dbCode: error.dbCode })
    }).finally(() => { cleaning = undefined })
  }, 60_000)
  cleanup.unref()

  function limit (key, maximum, duration = 15 * 60 * 1000) {
    const now = Date.now()
    let value = limits.get(key)
    if (value && value.expiresAt <= now) { limits.delete(key); value = undefined }
    if (!value) {
      if (limits.size >= 10_000) throw fail(503, 'AUTH_BUSY', '登录服务繁忙，请稍后重试')
      value = { count: 0, expiresAt: now + duration }
      limits.set(key, value)
    }
    if (++value.count > maximum) throw Object.assign(fail(429, 'RATE_LIMITED', '尝试次数过多，请稍后重试'), { retryAfter: Math.ceil((value.expiresAt - now) / 1000) })
  }

  function cookie (token = '') {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_MS / 1000 : 0}${secureCookies ? '; Secure' : ''}`
  }

  async function session (req, connection = db) {
    const token = readToken(req)
    if (!token) return null
    return await connection.get('SELECT users.* FROM users JOIN sessions ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.enabled = 1', [tokenHash(token), Date.now()]) || null
  }

  function authenticate (req) {
    if (closed) return Promise.reject(unavailable())
    return track(session(req).then(publicUser))
  }

  async function getUser (id, connection = db) {
    const user = await connection.get('SELECT * FROM users WHERE id = ?', [id])
    if (!user) throw fail(404, 'USER_NOT_FOUND', '用户不存在')
    return user
  }

  async function lockUser (id, connection) {
    // An unchanged update locks the row on all supported databases, including SQLite.
    // Login and account changes must serialize so a concurrent reset cannot leave a valid session.
    await connection.run('UPDATE users SET id = id WHERE id = ?', [id])
    return getUser(id, connection)
  }

  async function requireCurrentAdmin (req, actor, connection) {
    // Acquire the actor first, then the target user: every management mutation uses this order.
    await connection.run('UPDATE users SET id = id WHERE id = ?', [actor.id])
    const current = await session(req, connection)
    if (!current || current.id !== actor.id) throw fail(401, 'UNAUTHENTICATED', '请先登录')
    if (current.role !== 'admin') throw fail(403, 'ADMIN_REQUIRED', '只有管理员可以管理用户')
  }

  async function requireUniqueUsername (username, except = 0, connection = db) {
    if (await connection.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?', [username, except])) throw fail(409, 'USERNAME_EXISTS', '用户名已存在')
  }

  async function uniqueUserMutation (operation) {
    try { return await db.transaction(operation) } catch (error) {
      if (isUniqueViolation(error)) throw fail(409, 'USERNAME_EXISTS', '用户名已存在')
      throw error
    }
  }

  async function route (req, res, url) {
    const path = url.pathname.slice(PREFIX.length)
    const method = req.method
    assertSameOrigin(req, publicOrigin)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && req.headers['x-ifshare-request'] !== '1') throw fail(403, 'CSRF_REJECTED', '请求缺少安全校验标识')
    const ip = req.socket.remoteAddress || 'unknown'

    if (path === '/auth/challenge' && method === 'GET') {
      limit(`challenge:${ip}`, 300)
      if (challenges.size >= 2048) throw fail(503, 'AUTH_BUSY', '登录服务繁忙，请稍后重试')
      const challengeId = randomBytes(24).toString('hex')
      challenges.set(challengeId, { expiresAt: Date.now() + CHALLENGE_MS, ip })
      return send(res, 200, { challengeId, publicKey })
    }
    if (path === '/auth/login' && method === 'POST') {
      limit(`login:${ip}`, 300)
      const body = await readBody(req)
      allowFields(body, ['username', 'challengeId', 'password'])
      const username = validateUsername(body.username)
      limit(`user:${username.toLowerCase()}`, 20)
      const challenge = challenges.get(body.challengeId)
      challenges.delete(body.challengeId)
      if (!challenge || challenge.ip !== ip || challenge.expiresAt <= Date.now()) throw fail(400, 'INVALID_CHALLENGE', '登录请求已过期，请重试')
      let password
      let plaintext
      try {
        if (typeof body.password !== 'string' || !/^[A-Za-z0-9+/]{512}$/.test(body.password)) throw new Error('Invalid ciphertext')
        plaintext = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(`${body.challengeId}:${username}`) }, Buffer.from(body.password, 'base64'))
        if (!plaintext.length || plaintext.length > 256) throw new Error('Invalid password length')
        password = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
      } catch { throw fail(400, 'INVALID_CREDENTIAL_PAYLOAD', '登录加密数据无效，请重试') } finally { plaintext?.fill(0) }
      const user = await db.get('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username])
      const matches = await verifyPassword(password, user?.password_hash || dummyPassword)
      password = ''
      const current = user && await db.get('SELECT * FROM users WHERE id = ?', [user.id])
      if (!matches || !current?.enabled || current.password_hash !== user.password_hash || current.username !== user.username) {
        throw fail(401, 'INVALID_CREDENTIALS', '用户名或密码错误，或用户已停用')
      }
      const token = randomBytes(32).toString('hex')
      const authenticated = await db.transaction(async tx => {
        let latest
        try { latest = await lockUser(current.id, tx) } catch (error) {
          if (error.code === 'USER_NOT_FOUND') throw fail(401, 'INVALID_CREDENTIALS', '用户名或密码错误，或用户已停用')
          throw error
        }
        if (!latest.enabled || latest.password_hash !== user.password_hash || latest.username !== user.username) throw fail(401, 'INVALID_CREDENTIALS', '用户名或密码错误，或用户已停用')
        const old = readToken(req)
        if (old) await tx.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash(old)])
        const previous = await tx.all('SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, token_hash DESC', [current.id])
        for (const expired of previous.slice(15)) await tx.run('DELETE FROM sessions WHERE token_hash = ?', [expired.token_hash])
        await tx.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [tokenHash(token), current.id, Date.now() + SESSION_MS, Date.now()])
        const lastLogin = new Date().toISOString()
        await tx.run('UPDATE users SET last_login_at = ? WHERE id = ?', [lastLogin, current.id])
        return publicUser({ ...latest, last_login_at: lastLogin })
      })
      limits.delete(`user:${username.toLowerCase()}`)
      res.setHeader('Set-Cookie', cookie(token))
      emit('info', { event: 'session_created', userId: current.id })
      return send(res, 200, { user: authenticated })
    }
    if (path === '/auth/logout' && method === 'POST') {
      const token = readToken(req)
      if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash(token)])
      res.setHeader('Set-Cookie', cookie())
      return send(res, 204)
    }

    const actor = await authenticate(req)
    if (!actor) throw fail(401, 'UNAUTHENTICATED', '请先登录')
    if (path === '/auth/session' && method === 'GET') return send(res, 200, { user: actor })
    if (path === '/logs') {
      if (method === 'POST') {
        const body = validateLog(await readBody(req))
        let result
        try {
          result = await db.transaction(async tx => {
            // Recheck after receiving the body; the account may have been changed or removed meanwhile.
            await tx.run('UPDATE users SET id = id WHERE id = ?', [actor.id])
            const current = await session(req, tx)
            if (!current || current.id !== actor.id) throw fail(401, 'UNAUTHENTICATED', '请先登录')
            const previous = await tx.get('SELECT * FROM operation_logs WHERE user_id = ? AND event_id = ?', [actor.id, body.eventId])
            if (previous) return { log: previous, created: false }
            limit(`logs:${actor.id}`, 600, 60_000)
            const inserted = await tx.run('INSERT INTO operation_logs (user_id, username, event_id, action, file_name, file_path, cid, file_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [current.id, current.username, body.eventId, body.action, body.fileName, body.filePath, body.cid, body.fileCount, new Date().toISOString()])
            return { log: await tx.get('SELECT * FROM operation_logs WHERE id = ?', [inserted.lastInsertRowid]), created: true }
          })
        } catch (error) {
          if (!isUniqueViolation(error)) throw error
          const previous = await db.get('SELECT * FROM operation_logs WHERE user_id = ? AND event_id = ?', [actor.id, body.eventId])
          if (!previous) throw error
          return send(res, 200, { log: publicLog(previous) })
        }
        return send(res, result.created ? 201 : 200, { log: publicLog(result.log) })
      }
      if (method === 'GET') {
        const { q, page, pageSize } = pagination(url, 128)
        const action = url.searchParams.get('action') || ''
        if (action && !LOG_ACTIONS.includes(action)) throw fail(400, 'INVALID_QUERY', '查询参数无效')
        const conditions = []
        const values = []
        if (actor.role !== 'admin') { conditions.push('user_id = ?'); values.push(actor.id) }
        if (action) { conditions.push('action = ?'); values.push(action) }
        if (q) {
          conditions.push("(LOWER(file_name) LIKE LOWER(?) ESCAPE '!' OR LOWER(file_path) LIKE LOWER(?) ESCAPE '!' OR LOWER(cid) LIKE LOWER(?) ESCAPE '!' OR LOWER(username) LIKE LOWER(?) ESCAPE '!')")
          values.push(...Array(4).fill(searchPattern(q)))
        }
        const condition = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        const total = Number((await db.get(`SELECT COUNT(*) AS count FROM operation_logs ${condition}`, values)).count)
        const logs = (await db.all(`SELECT * FROM operation_logs ${condition} ORDER BY id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize])).map(publicLog)
        return send(res, 200, { logs, total, page, pageSize })
      }
      throw fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持')
    }
    if (path !== '/users' && !path.startsWith('/users/')) throw fail(404, 'NOT_FOUND', '接口不存在')
    if (actor.role !== 'admin') throw fail(403, 'ADMIN_REQUIRED', '只有管理员可以管理用户')

    if (path === '/users' && method === 'GET') {
      const { q, page, pageSize } = pagination(url, 64)
      const pattern = searchPattern(q)
      const condition = "WHERE LOWER(username) LIKE LOWER(?) ESCAPE '!' OR LOWER(display_name) LIKE LOWER(?) ESCAPE '!'"
      const total = Number((await db.get(`SELECT COUNT(*) AS count FROM users ${condition}`, [pattern, pattern])).count)
      const users = (await db.all(`SELECT * FROM users ${condition} ORDER BY id ASC LIMIT ? OFFSET ?`, [pattern, pattern, pageSize, (page - 1) * pageSize])).map(publicUser)
      return send(res, 200, { users, total, page, pageSize })
    }
    if (path === '/users' && method === 'POST') {
      const body = await readBody(req)
      allowFields(body, ['username', 'displayName', 'enabled'])
      const username = validateUsername(body.username)
      const displayName = validateDisplayName(body.displayName ?? '')
      const enabled = validateEnabled(body.enabled ?? true)
      await requireUniqueUsername(username)
      const passwordHash = await hashPassword('password')
      const user = await uniqueUserMutation(async tx => {
        await requireCurrentAdmin(req, actor, tx)
        await requireUniqueUsername(username, 0, tx)
        const now = new Date().toISOString()
        const result = await tx.run("INSERT INTO users (username, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?, ?)", [username, displayName, passwordHash, Number(enabled), now, now])
        return getUser(Number(result.lastInsertRowid), tx)
      })
      emit('info', { event: 'user_created', userId: user.id, actorId: actor.id })
      return send(res, 201, { user: publicUser(user) })
    }

    const match = /^\/users\/([1-9]\d*)(\/reset-password)?$/.exec(path)
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw fail(404, 'NOT_FOUND', '接口不存在')
    const id = Number(match[1])
    const user = await getUser(id)
    if (match[2] && method === 'POST') {
      const hash = await hashPassword('password')
      await db.transaction(async tx => {
        await requireCurrentAdmin(req, actor, tx)
        await lockUser(id, tx)
        await tx.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, new Date().toISOString(), id])
        await tx.run('DELETE FROM sessions WHERE user_id = ?', [id])
      })
      emit('info', { event: 'password_reset', userId: id, actorId: actor.id })
      return send(res, 204)
    }
    if (match[2]) throw fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持')
    if (method === 'GET') return send(res, 200, { user: publicUser(user) })
    if (method === 'PATCH') {
      const body = await readBody(req)
      allowFields(body, ['username', 'displayName', 'enabled'])
      if (!Object.keys(body).length) throw fail(400, 'EMPTY_UPDATE', '请提供要修改的字段')
      const updated = await uniqueUserMutation(async tx => {
        await requireCurrentAdmin(req, actor, tx)
        // Read current values after the request body has arrived; another request may have edited this user meanwhile.
        const current = await lockUser(id, tx)
        const username = body.username === undefined ? current.username : validateUsername(body.username)
        const displayName = body.displayName === undefined ? current.display_name : validateDisplayName(body.displayName)
        const enabled = body.enabled === undefined ? Boolean(current.enabled) : validateEnabled(body.enabled)
        if (current.role === 'admin' && (username !== current.username || !enabled)) throw fail(400, 'ADMIN_PROTECTED', '系统管理员不能修改用户名或停用')
        await requireUniqueUsername(username, id, tx)
        await tx.run('UPDATE users SET username = ?, display_name = ?, enabled = ?, updated_at = ? WHERE id = ?', [username, displayName, Number(enabled), new Date().toISOString(), id])
        if (!enabled || username !== current.username) await tx.run('DELETE FROM sessions WHERE user_id = ?', [id])
        return publicUser(await getUser(id, tx))
      })
      emit('info', { event: 'user_updated', userId: id, actorId: actor.id })
      return send(res, 200, { user: updated })
    }
    if (method === 'DELETE') {
      if (user.role === 'admin') throw fail(400, 'ADMIN_PROTECTED', '系统管理员不能删除')
      await db.transaction(async tx => {
        await requireCurrentAdmin(req, actor, tx)
        await tx.run('DELETE FROM users WHERE id = ?', [id])
      })
      emit('info', { event: 'user_deleted', userId: id, actorId: actor.id })
      return send(res, 204)
    }
    throw fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持')
  }

  async function respond (req, res, url) {
    try {
      if (closed) throw unavailable()
      await route(req, res, url)
    } catch (error) {
      if (!error.status) emit('error', { event: 'api_error', code: error.code || 'UNKNOWN', dbCode: error.dbCode })
      else if (error.status === 408) emit('warn', { event: 'api_request_timeout', code: error.code, status: error.status })
      else if (closed && error.status === 503) emit('warn', { event: 'api_shutdown_rejected', code: error.code, status: error.status })
      if (!res.destroyed && !res.writableEnded) {
        if (!req.complete) {
          res.shouldKeepAlive = false
          res.setHeader('Connection', 'close')
          req.resume()
        }
        if (error.status === 429) res.setHeader('Retry-After', String(error.retryAfter || 900))
        send(res, error.status || 500, { error: { code: error.status ? error.code : 'INTERNAL_ERROR', message: error.status ? error.message : '服务暂时不可用，请稍后重试' } })
      }
    }
  }

  async function handle (req, res) {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch {
      send(res, 400, { error: { code: 'INVALID_QUERY', message: '请求地址无效' } })
      return true
    }
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false
    const response = respond(req, res, url)
    if (closed) await response
    else await track(response)
    return true
  }

  function close () {
    if (closing) return closing
    closed = true
    clearInterval(cleanup)
    for (const controller of bodyReaders) controller.abort(unavailable())
    closing = (async () => {
      await Promise.allSettled([...active, cleaning])
      challenges.clear()
      limits.clear()
      await db.close()
    })()
    return closing
  }

  return { handle, authenticate, close }
}
