import http from 'node:http'
import https from 'node:https'
import { createReadStream, readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi, assertSameOrigin } from './api.mjs'
import { createLogger } from './logger.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

function endpoint (value, label) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label} must be an HTTP(S) origin without credentials or a path`)
  }
  return url
}

export function readConfig (env = process.env) {
  const port = Number(env.WEBUI_API_PORT || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEBUI_API_PORT must be between 1 and 65535')
  const host = env.WEBUI_API_HOST || '127.0.0.1'
  const origin = env.WEBUI_API_PUBLIC_ORIGIN ? endpoint(env.WEBUI_API_PUBLIC_ORIGIN, 'WEBUI_API_PUBLIC_ORIGIN') : null
  if (origin && origin.protocol !== 'https:' && !loopback.has(origin.hostname)) {
    throw new Error('A public deployment requires an HTTPS WEBUI_API_PUBLIC_ORIGIN')
  }
  if (!loopback.has(host) && origin?.protocol !== 'https:') throw new Error('A non-loopback listener requires an HTTPS WEBUI_API_PUBLIC_ORIGIN')
  const databaseType = ({ postgres: 'postgresql', postsql: 'postgresql' })[env.WEBUI_API_DB_TYPE] || env.WEBUI_API_DB_TYPE || 'sqlite'
  if (!['sqlite', 'mysql', 'mariadb', 'postgresql'].includes(databaseType)) throw new Error('WEBUI_API_DB_TYPE must be sqlite, mysql, mariadb or postgresql')
  const integer = (name, fallback, max) => {
    const value = Number(env[name] || fallback)
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}`)
    return value
  }
  const boolean = (name, fallback) => {
    if (env[name] === undefined || env[name] === '') return fallback
    if (['true', '1'].includes(env[name])) return true
    if (['false', '0'].includes(env[name])) return false
    throw new Error(`${name} must be true or false`)
  }
  const databaseTls = boolean('WEBUI_API_DB_SSL', false)
  if (env.WEBUI_API_DB_CA && !databaseTls) throw new Error('WEBUI_API_DB_CA requires WEBUI_API_DB_SSL=true')
  const logLevel = env.WEBUI_API_LOG_LEVEL || 'info'
  if (!['info', 'warn', 'error', 'silent'].includes(logLevel)) throw new Error('WEBUI_API_LOG_LEVEL must be info, warn, error or silent')
  return {
    host,
    port,
    publicOrigin: origin?.origin || '',
    secureCookies: origin?.protocol === 'https:',
    databasePath: path.resolve(env.WEBUI_API_DB || path.join(directory, 'data/ifshare.sqlite')),
    databaseType,
    databaseHost: env.WEBUI_API_DB_HOST || '127.0.0.1',
    databasePort: integer('WEBUI_API_DB_PORT', databaseType === 'postgresql' ? 5432 : 3306, 65535),
    databaseName: env.WEBUI_API_DB_NAME || 'ifshare',
    databaseUser: env.WEBUI_API_DB_USER || 'ifshare',
    databasePassword: env.WEBUI_API_DB_PASSWORD || '',
    databaseSsl: databaseTls ? (env.WEBUI_API_DB_CA ? { ca: readFileSync(env.WEBUI_API_DB_CA, 'utf8') } : true) : false,
    databaseCreate: boolean('WEBUI_API_DB_CREATE', true),
    databasePoolSize: integer('WEBUI_API_DB_POOL_SIZE', 10, 100),
    databaseQueryTimeoutMs: integer('WEBUI_API_DB_QUERY_TIMEOUT_MS', 15000, 120000),
    databaseAcquireTimeoutMs: integer('WEBUI_API_DB_ACQUIRE_TIMEOUT_MS', 10000, 120000),
    databaseQueueLimit: integer('WEBUI_API_DB_QUEUE_LIMIT', 100, 10000),
    bodyTimeoutMs: integer('WEBUI_API_BODY_TIMEOUT_MS', 15000, 120000),
    logLevel,
    staticDirectory: path.resolve(env.WEBUI_STATIC_DIR || path.join(directory, '../build')),
    rpcUrl: endpoint(env.KUBO_RPC_URL || 'http://127.0.0.1:5001', 'KUBO_RPC_URL'),
    gatewayUrl: endpoint(env.KUBO_GATEWAY_URL || 'http://127.0.0.1:8080', 'KUBO_GATEWAY_URL')
  }
}

function jsonError (response, status, code, message) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ error: { code, message } }))
}

function cleanHeaders (headers) {
  const result = {}
  const excluded = new Set(hopHeaders)
  for (const name of String(headers.connection || '').split(',')) excluded.add(name.trim().toLowerCase())
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !excluded.has(name.toLowerCase())) result[name] = value
  }
  return result
}

function proxy (request, response, target, gateway, logger) {
  const headers = cleanHeaders(request.headers)
  for (const key of Object.keys(headers)) {
    if (['cookie', 'authorization', 'referer', 'forwarded'].includes(key) || key.startsWith('x-forwarded-') || key.startsWith('x-ifshare-')) delete headers[key]
  }
  headers.host = target.host
  if (gateway) delete headers.origin
  else headers.origin = target.origin
  const transport = target.protocol === 'https:' ? https : http
  // Retain the raw path and query, including repeated Kubo RPC arguments.
  // No client-supplied URL is ever resolved against the upstream origin.
  const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port, method: request.method, path: request.url, headers }, incoming => {
    const forwarded = cleanHeaders(incoming.headers)
    for (const key of Object.keys(forwarded)) {
      if (key === 'set-cookie' || key === 'www-authenticate' || key.startsWith('access-control-')) delete forwarded[key]
    }
    // Preserve the API host boundary even if the gateway uses subdomain redirects.
    if (forwarded.location) {
      try {
        const redirect = new URL(forwarded.location, target)
        if (redirect.origin !== target.origin || !/^\/(ipfs|ipns)\//.test(redirect.pathname)) {
          incoming.destroy()
          jsonError(response, 502, 'UPSTREAM_REDIRECT', '网关返回了不受支持的重定向，请使用路径网关。')
          return
        }
        forwarded.location = redirect.pathname + redirect.search + redirect.hash
      } catch {
        incoming.destroy()
        jsonError(response, 502, 'UPSTREAM_REDIRECT', '网关重定向无效。')
        return
      }
    }
    forwarded['cache-control'] = 'private, no-store'
    forwarded['x-content-type-options'] = 'nosniff'
    if (gateway) {
      forwarded['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
      forwarded['referrer-policy'] = 'no-referrer'
    }
    response.writeHead(incoming.statusCode || 502, forwarded)
    incoming.on('error', error => {
      if (!response.destroyed) logger.error({ event: 'upstream_stream_failed', code: error.code || 'STREAM_ERROR', channel: gateway ? 'gateway' : 'rpc' })
      response.destroy()
    })
    incoming.pipe(response)
    response.once('close', () => incoming.destroy())
  })
  // Idle timeout, not a total duration limit: large active transfers keep flowing.
  upstream.setTimeout(600000, () => upstream.destroy(Object.assign(new Error('Upstream idle timeout'), { code: 'UPSTREAM_IDLE_TIMEOUT' })))
  upstream.on('error', error => {
    if (response.destroyed || request.aborted) return
    logger.error({ event: 'upstream_request_failed', code: error.code || 'UPSTREAM_ERROR', channel: gateway ? 'gateway' : 'rpc' })
    jsonError(response, 502, 'NODE_UNAVAILABLE', '无法连接到 IFShare 节点，请检查后台服务。')
  })
  request.once('aborted', () => upstream.destroy())
  request.once('error', () => upstream.destroy())
  response.once('close', () => upstream.destroy())
  request.pipe(upstream)
}

async function serveStatic (request, response, staticDirectory, pathname, logger) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch {
    jsonError(response, 400, 'INVALID_PATH', '请求路径无效。')
    return
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.')) || /^\/auth(?:\/|$)/.test(decoded)) {
    jsonError(response, 404, 'NOT_FOUND', '资源不存在。')
    return
  }
  try {
    const root = await realpath(staticDirectory)
    const candidate = await realpath(path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded)))
    if (!candidate.startsWith(root + path.sep)) {
      jsonError(response, 404, 'NOT_FOUND', '资源不存在。')
      return
    }
    const info = await stat(candidate)
    if (!info.isFile()) {
      jsonError(response, 404, 'NOT_FOUND', '资源不存在。')
      return
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(candidate).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': /\.[0-9a-f]{8,}\./i.test(candidate) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    const stream = createReadStream(candidate)
    stream.on('error', error => {
      logger.error({ event: 'static_stream_failed', code: error.code || 'STREAM_ERROR' })
      response.destroy()
    })
    response.once('close', () => stream.destroy())
    stream.pipe(response)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') jsonError(response, 404, 'NOT_FOUND', '页面资源不存在，请先构建 WebUI。')
    else {
      logger.error({ event: 'static_read_failed', code: error.code || 'STATIC_ERROR' })
      jsonError(response, 500, 'STATIC_UNAVAILABLE', '页面资源暂时不可用。')
    }
  }
}

export async function createHost (options = {}, apiFactory = createApi) {
  const config = { ...readConfig(), ...options }
  const relativeDatabasePath = path.relative(config.staticDirectory, config.databasePath)
  if (config.databaseType === 'sqlite' && !relativeDatabasePath.startsWith('..' + path.sep) && relativeDatabasePath !== '..' && !path.isAbsolute(relativeDatabasePath)) {
    throw new Error('WEBUI_API_DB must be outside WEBUI_STATIC_DIR')
  }
  const logger = options.logger || createLogger({ level: config.logLevel })
  config.logger = logger
  let api
  try { api = await apiFactory(config) } catch (error) {
    if (!options.logger) logger.close()
    throw error
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) {
        jsonError(response, 400, 'INVALID_PATH', '请求路径无效。')
        return
      }
      const url = new URL(request.url, 'http://localhost')
      if (!config.publicOrigin) {
        const requestedHost = new URL('http://' + request.headers.host).hostname
        if (!loopback.has(requestedHost)) {
          jsonError(response, 403, 'INVALID_HOST', '请通过 localhost 访问开发服务。')
          return
        }
      }
      if (await api.handle(request, response)) return
      const rpc = /^\/api\/v0(?:\/|$)/.test(url.pathname)
      const gateway = /^\/(ipfs|ipns)(?:\/|$)/.test(url.pathname)
      if (rpc || gateway) {
        if (!await api.authenticate(request)) {
          jsonError(response, 401, 'UNAUTHENTICATED', '请先登录。')
          return
        }
        assertSameOrigin(request, config.publicOrigin)
        if (gateway && !['GET', 'HEAD'].includes(request.method)) {
          response.setHeader('Allow', 'GET, HEAD')
          jsonError(response, 405, 'METHOD_NOT_ALLOWED', '网关仅支持读取文件。')
          return
        }
        proxy(request, response, rpc ? config.rpcUrl : config.gatewayUrl, gateway, logger)
        return
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        jsonError(response, 405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。')
        return
      }
      await serveStatic(request, response, config.staticDirectory, url.pathname, logger)
    } catch (error) {
      if (!error.status || error.status >= 500) logger.error({ event: 'host_request_failed', code: error.code || 'INTERNAL_ERROR', dbCode: error.dbCode })
      jsonError(response, error.status || 500, error.code || 'INTERNAL_ERROR', error.status ? error.message : '服务暂时不可用。')
    }
  })
  // Kubo uploads can take longer than Node's default 5-minute request limit.
  server.requestTimeout = 0
  server.headersTimeout = 60000
  server.timeout = 600000
  let closing
  return {
    server,
    config,
    close: () => {
      if (!closing) {
        closing = (async () => {
          try {
            server.closeAllConnections()
            if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          } finally {
            try { await api.close() } finally { if (!options.logger) logger.close() }
          }
        })()
      }
      return closing
    }
  }
}
