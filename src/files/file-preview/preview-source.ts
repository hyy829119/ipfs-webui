import { toLoopbackIpUrl } from '../../lib/share-link.js'
export const LOCAL_PREVIEW_TIMEOUT = 1500
export const MAX_TEXT_PREVIEW = 256 * 1024

export interface PreviewSource {
  url: string
  fallbackUrl: string
  local: boolean
  mime: string
}

export type PreviewRead = (offset: number, length: number, options?: { signal?: AbortSignal }) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>

export function contentUrl (gateway: string, cid: string, name: string): string {
  return gateway ? toLoopbackIpUrl(`${gateway.replace(/\/+$/, '')}/ipfs/${cid}?filename=${encodeURIComponent(name)}`) : ''
}

export async function withPreviewTimeout<T> (signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>, timeout = LOCAL_PREVIEW_TIMEOUT): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort)
  const timer = setTimeout(abort, timeout)
  if (signal.aborted) abort()
  try {
    return await task(controller.signal)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export async function resolvePreviewSource (gateway: string, localGateway: string, cid: string, name: string, signal: AbortSignal): Promise<PreviewSource> {
  const fallbackUrl = contentUrl(gateway, cid, name)
  const localUrl = contentUrl(localGateway, cid, name)
  if (localUrl && localUrl !== fallbackUrl) {
    try {
      const response = await withPreviewTimeout(signal, async (localSignal) => await fetch(localUrl, {
        method: 'HEAD', signal: localSignal, credentials: 'omit', referrerPolicy: 'no-referrer'
      }))
      if (response.ok) {
        return { url: localUrl, fallbackUrl, local: true, mime: response.headers.get('Content-Type') || '' }
      }
    } catch (error) {
      if (signal.aborted) throw error
      // Unavailable content, browser restrictions and timeouts use the server.
    }
  }
  return { url: fallbackUrl, fallbackUrl, local: false, mime: '' }
}

export function mediaType (mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return type === 'application/pdf' ? 'pdf' : ''
}

async function readChunks (chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const result = new Uint8Array(MAX_TEXT_PREVIEW + 1)
  let length = 0
  for await (const chunk of chunks) {
    if (signal.aborted) throw new Error('Preview cancelled')
    const part = chunk.subarray(0, result.length - length)
    result.set(part, length)
    length += part.length
    if (length === result.length) break
  }
  return result.subarray(0, length)
}

async function * responseChunks (response: Response): AsyncGenerator<Uint8Array> {
  if (!response.ok || !response.body) throw new Error('Preview unavailable')
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

export async function readPreviewBytes (source: PreviewSource, read: PreviewRead, signal: AbortSignal): Promise<{ bytes: Uint8Array, local: boolean }> {
  if (source.local) {
    try {
      const bytes = await withPreviewTimeout(signal, async (localSignal) => {
        const response = await fetch(source.url, { signal: localSignal, credentials: 'omit', referrerPolicy: 'no-referrer' })
        return await readChunks(responseChunks(response), localSignal)
      })
      return { bytes, local: true }
    } catch (error) {
      if (signal.aborted) throw error
    }
  }
  return { bytes: await readChunks(await read(0, MAX_TEXT_PREVIEW + 1, { signal }), signal), local: false }
}

export function decodePreviewText (bytes: Uint8Array, size: number): { text: string, truncated: boolean } {
  const truncated = bytes.length > MAX_TEXT_PREVIEW || size > MAX_TEXT_PREVIEW
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe
    ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(0, MAX_TEXT_PREVIEW), { stream: truncated })
  // HTML and code remain text; reject binary controls before rendering.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error('Binary file')
  return { text, truncated }
}
