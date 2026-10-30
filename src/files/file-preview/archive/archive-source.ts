import type { PreviewRead, PreviewSource } from '../preview-source'
import { ArchiveError, MOBILE_ARCHIVE_BYTES } from './archive-utils'

const CHUNK_SIZE = 1024 * 1024
interface InputSink { append: (bytes: Uint8Array) => Promise<void>, reset: () => Promise<void> }

export async function readArchive (source: PreviewSource, read: PreviewRead, size: number, smallScreen: boolean, sink: InputSink, signal: AbortSignal, progress: (loaded: number) => void): Promise<PreviewSource> {
  if (smallScreen && size > MOBILE_ARCHIVE_BYTES) throw new ArchiveError('tooLarge')
  let loaded = 0
  const consume = async (bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      if (signal.aborted) throw new ArchiveError('cancelled')
      const chunk = bytes.slice(offset, offset + CHUNK_SIZE)
      loaded += chunk.byteLength
      if (smallScreen && loaded > MOBILE_ARCHIVE_BYTES) throw new ArchiveError('tooLarge')
      await sink.append(chunk)
      progress(loaded)
    }
  }
  if (source.url) {
    const local = new AbortController()
    const abort = () => local.abort()
    signal.addEventListener('abort', abort)
    if (signal.aborted) abort()
    // Only stalled network reads time out; active downloads may run indefinitely.
    let idle = setTimeout(abort, 30000)
    try {
      const response = await fetch(source.url, { signal: local.signal, credentials: source.local ? 'omit' : 'same-origin', referrerPolicy: 'no-referrer' })
      if (!response.ok || !response.body?.getReader) throw new ArchiveError('failed')
      const reader = response.body.getReader()
      try {
        while (true) {
          clearTimeout(idle)
          idle = setTimeout(abort, 30000)
          const { done, value } = await reader.read()
          clearTimeout(idle)
          if (done) break
          await consume(value)
        }
      } finally {
        try { await reader.cancel() } finally { reader.releaseLock() }
      }
      if (signal.aborted) throw new ArchiveError('cancelled')
      if (size > 0 && loaded !== size) throw new ArchiveError('failed')
      return source
    } catch (error) {
      if (signal.aborted || (error instanceof ArchiveError && ['tooLarge', 'storage', 'unsupported'].includes(error.code))) throw error
      await sink.reset()
      loaded = 0
      progress(0)
    } finally {
      clearTimeout(idle)
      signal.removeEventListener('abort', abort)
    }
  }
  // Bounded RPC ranges also work when a browser cannot stream gateway responses.
  while (true) {
    if (size > 0 && loaded >= size) break
    if (signal.aborted) throw new ArchiveError('cancelled')
    let length = 0
    for await (const chunk of await read(loaded, CHUNK_SIZE, { signal })) {
      length += chunk.length
      if (length > CHUNK_SIZE) throw new ArchiveError('failed')
      await consume(chunk)
    }
    if (length < CHUNK_SIZE) break
  }
  if (signal.aborted) throw new ArchiveError('cancelled')
  if (size > 0 && loaded !== size) throw new ArchiveError('failed')
  return { ...source, local: false, url: source.fallbackUrl }
}
