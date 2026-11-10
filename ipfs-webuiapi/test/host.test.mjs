import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHost, readConfig } from '../host.mjs'

let directory
let upstream
let host
let origin
let upstreamOrigin
let seen
let slowClosed
let apiClosed = false
const runtimeEvents = []

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ifshare-host-'))
  await mkdir(path.join(directory, 'build'))
  await writeFile(path.join(directory, 'build/index.html'), '<html>IFShare</html>')
  await writeFile(path.join(directory, 'secret.sqlite'), 'secret')
  await symlink(path.join(directory, 'secret.sqlite'), path.join(directory, 'build/leak.txt'))
  await writeFile(path.join(directory, 'build/.env'), 'secret')
  await writeFile(path.join(directory, 'build/archive.wasm'), Buffer.from([0, 97, 115, 109]))
  upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen = { url: request.url, headers: request.headers, body: Buffer.concat(chunks) }
    if (request.url.includes('/slow')) {
      slowClosed = new Promise(resolve => response.once('close', resolve))
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.write('first chunk')
      return
    }
    if (request.url.includes('redirect-external')) {
      response.writeHead(302, { Location: 'https://example.com/private' })
      response.end()
      return
    }
    if (request.url.includes('redirect-local')) {
      response.writeHead(301, { Location: upstreamOrigin + '/ipfs/directory/' })
      response.end()
      return
    }
    response.writeHead(request.headers.range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Set-Cookie': 'upstream_token=secret',
      'Access-Control-Allow-Origin': '*',
      ...(request.headers.range ? { 'Content-Range': 'bytes 0-3/10' } : {})
    })
    response.end(request.method === 'POST' ? seen.body : Buffer.from([0, 255, 2, 3]))
  })
  upstreamOrigin = await listen(upstream)
  host = await createHost({
    databasePath: path.join(directory, 'auth.sqlite'),
    staticDirectory: path.join(directory, 'build'),
    rpcUrl: new URL(upstreamOrigin),
    gatewayUrl: new URL(upstreamOrigin),
    publicOrigin: '',
    logger: { error: event => runtimeEvents.push(event) }
  }, async () => ({
    handle: async (request, response) => {
      if (request.url !== '/webui-api/v1/auth/session') return false
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ user: { username: 'admin' } }))
      return true
    },
    authenticate: async request => request.headers.cookie === 'ifshare_session=test' ? { username: 'admin' } : null,
    close: async () => { await Promise.resolve(); apiClosed = true }
  }))
  origin = await listen(host.server)
})

after(async () => {
  if (host) await host.close()
  if (upstream) {
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
  if (directory) await rm(directory, { recursive: true, force: true })
  if (host) assert.equal(apiClosed, true)
})

const cookie = { Cookie: 'ifshare_session=test' }

test('serves public application assets and API routes', async () => {
  const response = await fetch(origin)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /IFShare/)
  const wasm = await fetch(origin + '/archive.wasm')
  assert.equal(wasm.headers.get('content-type'), 'application/wasm')
  assert.deepEqual(Buffer.from(await wasm.arrayBuffer()), Buffer.from([0, 97, 115, 109]))
  assert.deepEqual(await (await fetch(origin + '/webui-api/v1/auth/session')).json(), { user: { username: 'admin' } })
})

test('rejects anonymous RPC and gateway requests', async () => {
  for (const url of ['/api/v0/id', '/ipfs/example', '/ipns/example']) {
    const response = await fetch(origin + url, { method: url.startsWith('/api') ? 'POST' : 'GET' })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED')
  }
})

test('streams upload bytes and repeated RPC arguments without session credentials', async () => {
  const bytes = Buffer.alloc(1024 * 1024, 205)
  const response = await fetch(origin + '/api/v0/add?arg=one&arg=two', {
    method: 'POST',
    headers: { ...cookie, Origin: origin, Authorization: 'Bearer private', 'X-Forwarded-For': 'untrusted', 'X-IFShare-Request': '1', 'Content-Type': 'application/octet-stream' },
    body: bytes
  })
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal(seen.url, '/api/v0/add?arg=one&arg=two')
  assert.equal(seen.headers.origin, upstreamOrigin)
  assert.equal(seen.headers.cookie, undefined)
  assert.equal(seen.headers.authorization, undefined)
  assert.equal(seen.headers['x-forwarded-for'], undefined)
  assert.equal(seen.headers['x-ifshare-request'], undefined)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('preserves gateway Range responses and adds a sandbox', async () => {
  const response = await fetch(origin + '/ipfs/example', { headers: { ...cookie, Range: 'bytes=0-3' } })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/10')
  assert.match(response.headers.get('content-security-policy'), /^sandbox;/)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 255, 2, 3]))
  assert.equal(seen.headers.origin, undefined)
})

test('cancels the upstream stream when the browser disconnects', { timeout: 5000 }, async () => {
  const controller = new AbortController()
  const response = await fetch(origin + '/ipfs/slow', { headers: cookie, signal: controller.signal })
  const reader = response.body.getReader()
  assert.equal((await reader.read()).done, false)
  controller.abort()
  await assert.rejects(reader.read(), { name: 'AbortError' })
  await slowClosed
})

test('rejects cross-origin mutation and gateway writes', async () => {
  assert.equal((await fetch(origin + '/api/v0/config', { method: 'POST', headers: { ...cookie, Origin: 'https://attacker.example' } })).status, 403)
  assert.equal((await fetch(origin + '/api/v0/config', { method: 'POST', headers: { ...cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await fetch(origin + '/ipfs/example', { method: 'POST', headers: cookie })).status, 405)
})

test('does not expose hidden files, symlink escapes, legacy auth, or parent paths', async () => {
  for (const pathname of ['/leak.txt', '/.env', '/%2eenv', '/%2e%2e/secret.sqlite', '/auth/session.json', '/..%5csecret.sqlite', '/%00']) {
    const response = await fetch(origin + pathname)
    assert.ok([400, 404].includes(response.status), `${pathname}: ${response.status}`)
    assert.doesNotMatch(await response.text(), /secret/)
  }
})

test('rewrites local gateway redirects and rejects redirects outside the proxy', async () => {
  const response = await fetch(origin + '/ipfs/redirect-local', { headers: cookie, redirect: 'manual' })
  assert.equal(response.status, 301)
  assert.equal(response.headers.get('location'), '/ipfs/directory/')
  assert.equal((await fetch(origin + '/ipfs/redirect-external', { headers: cookie, redirect: 'manual' })).status, 502)
})

test('requires HTTPS for public deployments and validates fixed upstreams', () => {
  assert.throws(() => readConfig({ WEBUI_API_HOST: '0.0.0.0' }), /PUBLIC_ORIGIN/)
  assert.throws(() => readConfig({ WEBUI_API_PUBLIC_ORIGIN: 'http://files.example' }), /HTTPS/)
  assert.throws(() => readConfig({ KUBO_RPC_URL: 'file:///tmp/private' }), /HTTP/)
  assert.throws(() => readConfig({ KUBO_RPC_URL: 'http://user:password@127.0.0.1:5001' }), /credentials/)
  assert.throws(() => readConfig({ WEBUI_API_PORT: '65536' }), /65535/)
  const config = readConfig({ WEBUI_API_PUBLIC_ORIGIN: 'https://files.example' })
  assert.equal(config.secureCookies, true)
  assert.equal(config.publicOrigin, 'https://files.example')
})

test('rejects a database placed under the public static directory', async () => {
  await assert.rejects(createHost({ databasePath: path.join(directory, 'build/auth.sqlite'), staticDirectory: path.join(directory, 'build') }), /outside WEBUI_STATIC_DIR/)
})

test('returns a bounded gateway error when the node is down', async () => {
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const response = await fetch(origin + '/ipfs/example', { headers: cookie })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'NODE_UNAVAILABLE')
})

test('normalizes and validates database connection configuration', () => {
  assert.equal(readConfig({}).databaseType, 'sqlite')
  assert.equal(readConfig({}).databaseCreate, true)
  for (const type of ['postgresql', 'postgres', 'postsql']) {
    const config = readConfig({ WEBUI_API_DB_TYPE: type, WEBUI_API_DB_CREATE: 'false', WEBUI_API_DB_SSL: 'true' })
    assert.equal(config.databaseType, 'postgresql')
    assert.equal(config.databasePort, 5432)
    assert.equal(config.databaseCreate, false)
    assert.equal(config.databaseSsl, true)
  }
  for (const type of ['mysql', 'mariadb']) assert.equal(readConfig({ WEBUI_API_DB_TYPE: type }).databasePort, 3306)
  for (const env of [
    { WEBUI_API_DB_TYPE: 'unknown' },
    { WEBUI_API_DB_PORT: '65536' },
    { WEBUI_API_DB_PORT: 'no' },
    { WEBUI_API_DB_POOL_SIZE: '0' },
    { WEBUI_API_DB_POOL_SIZE: '101' },
    { WEBUI_API_DB_CREATE: 'maybe' },
    { WEBUI_API_DB_SSL: 'insecure' },
    { WEBUI_API_DB_CA: '/unused' },
    { WEBUI_API_DB_QUERY_TIMEOUT_MS: '0' },
    { WEBUI_API_DB_ACQUIRE_TIMEOUT_MS: '120001' },
    { WEBUI_API_DB_QUEUE_LIMIT: '10001' }
  ]) assert.throws(() => readConfig(env), /WEBUI_API_DB/)
})

test('validates runtime diagnostics and JSON-body limits independently from file streaming', () => {
  assert.equal(readConfig({}).bodyTimeoutMs, 15000)
  assert.equal(readConfig({}).databaseQueueLimit, 100)
  assert.equal(readConfig({}).logLevel, 'info')
  assert.throws(() => readConfig({ WEBUI_API_BODY_TIMEOUT_MS: '0' }), /BODY_TIMEOUT/)
  assert.throws(() => readConfig({ WEBUI_API_LOG_LEVEL: 'debug-all' }), /LOG_LEVEL/)
  assert.equal(host.server.requestTimeout, 0)
})

test('emits safe diagnostics for a failed upstream without query strings or credentials', () => {
  const event = runtimeEvents.find(entry => entry.event === 'upstream_request_failed')
  assert.ok(event)
  assert.equal(event.channel, 'gateway')
  assert.deepEqual(Object.keys(event).sort(), ['channel', 'code', 'event'])
})
