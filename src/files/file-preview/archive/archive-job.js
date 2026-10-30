import { archiveFailure, checkSignature, extractEntry, listArchive, manifestEntries, manifestPage, MOBILE_BYTES, MOBILE_ENTRIES } from './archive-engine.js'

export function createArchiveJob ({ createEngine, getRoot, onProgress }) {
  let engine, directory, input, manifest
  let inputLength = 0
  let count = 0
  let total = 0
  let limited = false
  let ready = false
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
    handle.truncate(0)
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
  }

  const operations = {
    async init ({ session, smallScreen }) {
      limited = smallScreen
      const root = await getRoot()
      const parent = await root.getDirectoryHandle('ifshare-archives', { create: true })
      directory = await parent.getDirectoryHandle(session, { create: true })
      input = await writable('input')
      engine = await createEngine()
      engine.FS.mkdir('/input')
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
      const signature = new Uint8Array(8)
      input.read(signature, { at: 0 })
      checkSignature(signature, format)
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
          })
          tar.flush()
        } finally { tar.close() }
        engine.FS.unmount('/input')
        await directory.removeEntry('input')
        await mount('payload')
      }
      progress({ phase: 'scanning', loaded: 0, total: 0 }, true)
      const index = await writable('manifest')
      const encoder = new TextEncoder()
      let indexOffset = 0
      try {
        listArchive(engine, '/input/archive', password, entry => {
          if (limited && (count >= MOBILE_ENTRIES || total + entry.size > MOBILE_BYTES)) throw archiveFailure('tooLarge')
          const bytes = encoder.encode(JSON.stringify({ ...entry, id: count }) + '\n')
          if (index.write(bytes, { at: indexOffset }) !== bytes.length) throw archiveFailure('storage')
          indexOffset += bytes.length
          count++
          total += entry.size
          progress({ phase: 'scanning', loaded: count, total: 0 })
        })
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
          })
          if (offset !== entry.size) throw archiveFailure('invalid')
          output.flush()
        } finally { output.close() }
        processed += offset
        completed++
        progress({ phase: 'extracting', loaded: processed, total, completed, count, file: entry.path }, completed === count)
      }
      engine.FS.unmount('/input')
      await directory.removeEntry(format === 'tar.gz' ? 'payload' : 'input')
      ready = true
      return { count, total }
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
  return operations
}
