import { archiveFailure, checkSignature, extractEntry, listArchive, manifestEntries, manifestPage, MOBILE_BYTES, MOBILE_ENTRIES } from './archive-engine.js'

export function createArchiveJob ({ createEngine, getRoot, onProgress }) {
  let engine, directory, input, manifest
  let inputLength = 0
  let count = 0
  let total = 0
  let limited = false
  let ready = false
  let mounted = false
  let lastProgress = 0

  function progress (value, force = false) {
    if (force || Date.now() - lastProgress > 100) {
      onProgress(value)
      lastProgress = Date.now()
    }
  }

  async function writable (name) {
    const file = await directory.getFileHandle(name, { create: true })
    if (typeof file.createSyncAccessHandle !== 'function') throw archiveFailure('unsupported')
    const handle = await file.createSyncAccessHandle()
    try { handle.truncate(0) } catch (error) {
      handle.close()
      throw error
    }
    return handle
  }

  function write (handle, bytes, at) {
    if (limited && at + bytes.byteLength > MOBILE_BYTES) throw archiveFailure('tooLarge')
    if (handle.write(bytes, { at }) !== bytes.byteLength) throw archiveFailure('storage')
  }

  async function file (name) {
    return await (await directory.getFileHandle(name)).getFile()
  }

  async function mount (name) {
    engine.FS.mount(engine.WORKERFS, { blobs: [{ name: 'archive', data: await file(name) }] }, '/input')
    mounted = true
  }

  function unmount () {
    if (!mounted) return
    engine.FS.unmount('/input')
    mounted = false
  }

  function releaseDecoder () {
    try {
      input?.close()
    } finally {
      input = null
      try { unmount() } finally { engine = null }
    }
  }

  const operations = {
    async init ({ session, smallScreen }) {
      limited = smallScreen
      const root = await getRoot()
      const parent = await root.getDirectoryHandle('ifshare-archives', { create: true })
      directory = await parent.getDirectoryHandle(session, { create: true })
      try {
        input = await writable('input')
        engine = await createEngine()
        engine.FS.mkdir('/input')
      } catch (error) {
        releaseDecoder()
        throw error
      }
    },
    reset () {
      input.truncate(0)
      inputLength = 0
    },
    append ({ bytes }) {
      write(input, bytes, inputLength)
      inputLength += bytes.byteLength
    },
    async unpack ({ format, password }) {
      try {
        return await unpack(format, password)
      } finally {
        // Downloads and pagination only need OPFS. Drop decoder memory and
        // release all input handles even on a corrupt archive or quota error.
        releaseDecoder()
      }
    },
    async page ({ query, page }) {
      if (!ready || !Number.isSafeInteger(page) || page < 0) throw archiveFailure('invalid')
      return await manifestPage(manifest, query, page)
    },
    async file ({ id }) {
      if (!ready || !Number.isSafeInteger(id) || id < 0 || id >= count) throw archiveFailure('invalid')
      return await file(`file-${id}`)
    }
  }

  async function unpack (format, password) {
    const signature = new Uint8Array(Math.min(inputLength, 1024))
    input.read(signature, { at: 0 })
    checkSignature(signature, format)
    const emptyTar = format === 'tar' && signature.every(byte => byte === 0)
    if (emptyTar) {
      // 7-Zip rejects TARs containing only end markers. Verify the remaining
      // padding in bounded reads, then use the normal empty-manifest flow.
      if (inputLength % 512 !== 0) throw archiveFailure('invalid')
      const padding = new Uint8Array(65536)
      for (let offset = signature.length; offset < inputLength; offset += padding.length) {
        const length = Math.min(padding.length, inputLength - offset)
        const bytes = padding.subarray(0, length)
        if (input.read(bytes, { at: offset }) !== length || bytes.some(byte => byte !== 0)) throw archiveFailure('invalid')
      }
    }
    const decoderFormat = format === 'tar.gz' ? 'tar' : format === 'rar' && signature[6] === 1 ? 'rar5' : format
    input.flush()
    input.close()
    input = null
    await mount('input')
    if (format === 'tar.gz') {
      progress({ phase: 'unpackingTar', loaded: 0, total: 0 }, true)
      const tar = await writable('payload')
      let offset = 0
      try {
        extractEntry(engine, '/input/archive', null, password, bytes => {
          write(tar, bytes, offset)
          offset += bytes.length
          progress({ phase: 'unpackingTar', loaded: offset, total: 0 })
        }, 'gzip')
        tar.flush()
      } finally { tar.close() }
      unmount()
      await directory.removeEntry('input')
      await mount('payload')
    }
    progress({ phase: 'scanning', loaded: 0, total: 0 }, true)
    const index = await writable('manifest')
    const encoder = new TextEncoder()
    let indexOffset = 0
    try {
      if (!emptyTar) {
        listArchive(engine, '/input/archive', password, entry => {
          if (limited && (count >= MOBILE_ENTRIES || total + entry.size > MOBILE_BYTES)) throw archiveFailure('tooLarge')
          const bytes = encoder.encode(JSON.stringify({ ...entry, id: count }) + '\n')
          if (index.write(bytes, { at: indexOffset }) !== bytes.length) throw archiveFailure('storage')
          indexOffset += bytes.length
          count++
          total += entry.size
          progress({ phase: 'scanning', loaded: count, total: 0 })
        }, decoderFormat)
      }
      index.flush()
    } finally { index.close() }
    manifest = await file('manifest')
    let processed = 0
    let completed = 0
    for await (const entry of manifestEntries(manifest)) {
      const output = await writable(`file-${entry.id}`)
      let offset = 0
      const base = { loaded: processed, total, completed, count }
      try {
        extractEntry(engine, '/input/archive', entry.path, password, bytes => {
          if (offset + bytes.length > entry.size) throw archiveFailure('invalid')
          write(output, bytes, offset)
          offset += bytes.length
          progress({ ...base, phase: 'extracting', loaded: base.loaded + offset, file: entry.path })
        }, decoderFormat)
        if (offset !== entry.size) throw archiveFailure('invalid')
        output.flush()
      } finally { output.close() }
      processed += offset
      completed++
      progress({ phase: 'extracting', loaded: processed, total, completed, count, file: entry.path }, completed === count)
    }
    unmount()
    await directory.removeEntry(format === 'tar.gz' ? 'payload' : 'input')
    ready = true
    return { count, total }
  }
  return operations
}
