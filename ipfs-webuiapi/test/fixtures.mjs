import assert from 'node:assert/strict'
import { constants, publicEncrypt } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../api.mjs'

const PREFIX = '/webui-api/v1'

export async function fixture (options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ifshare-webuiapi-'))
  const databasePath = join(directory, 'nested', 'users.sqlite')
  let api
  let server
  let origin
  async function start () {
    api = await createApi({ databasePath, ...options })
    server = createServer(async (req, res) => {
      if (!await api.handle(req, res)) { res.statusCode = 404; res.end() }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = `http://127.0.0.1:${server.address().port}`
  }
  async function stop () {
    if (!server) return
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await api.close()
    server = null
  }
  try { await start() } catch (error) {
    await stop()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    databasePath,
    get api () { return api },
    get origin () { return origin },
    async request (path, { method = 'GET', cookie = '', body, headers = {} } = {}) {
      const response = await fetch(origin + PREFIX + path, {
        method,
        headers: { Cookie: cookie, Origin: options.publicOrigin || origin, 'X-IFShare-Request': '1', ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null, cookie: (response.headers.get('set-cookie') || '').split(';')[0], headers: response.headers }
    },
    async pendingJson (path, { method = 'POST', cookie, body }) {
      const payload = Buffer.from(JSON.stringify(body))
      let bodyReady
      const ready = new Promise(resolve => { bodyReady = resolve })
      const observe = req => {
        if (req.url !== PREFIX + path) return
        server.off('request', observe)
        req.once('resume', bodyReady)
      }
      server.on('request', observe)
      let outgoing
      const response = new Promise((resolve, reject) => {
        outgoing = request(origin + PREFIX + path, {
          method,
          headers: { Cookie: cookie, Origin: options.publicOrigin || origin, 'X-IFShare-Request': '1', 'Content-Type': 'application/json', 'Content-Length': payload.length }
        }, incoming => {
          const chunks = []
          incoming.on('data', chunk => chunks.push(chunk))
          incoming.on('end', () => {
            const text = Buffer.concat(chunks).toString()
            resolve({ status: incoming.statusCode, body: text ? JSON.parse(text) : null, headers: incoming.headers })
          })
          incoming.on('error', reject)
        })
        outgoing.on('error', reject)
      })
      const closed = new Promise(resolve => outgoing.once('close', resolve))
      outgoing.write(payload.subarray(0, 1))
      await Promise.race([ready, response.then(result => { throw new Error(`Request rejected before body read: ${result.status}`) })])
      return {
        response,
        closed,
        write (chunk) { outgoing.write(chunk) },
        async finish () { outgoing.end(payload.subarray(1)); return response },
        cancel () { outgoing.destroy(); response.catch(() => {}); server.off('request', observe) }
      }
    },
    async restart () { await stop(); await start() },
    async close () { await stop(); await rm(directory, { recursive: true, force: true }) }
  }
}

export async function encryptedLogin (app, username = 'admin', password = 'password') {
  const challenge = await app.request('/auth/challenge')
  assert.equal(challenge.status, 200)
  const { challengeId, publicKey } = challenge.body
  return {
    username,
    challengeId,
    password: publicEncrypt({ key: publicKey, format: 'jwk', oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING, oaepLabel: Buffer.from(`${challengeId}:${username}`) }, Buffer.from(password)).toString('base64')
  }
}

export async function login (app, username = 'admin', password = 'password') {
  return app.request('/auth/login', { method: 'POST', body: await encryptedLogin(app, username, password) })
}
