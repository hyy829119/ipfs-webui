import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, ftruncateSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import SevenZip from '7z-wasm'
import { createArchiveJob } from '../../src/files/file-preview/archive/archive-job.js'
import { checkSignature, detectArchiveFormat, manifestPage } from '../../src/files/file-preview/archive/archive-engine.js'

// Exercise the production job and real WASM/WORKERFS with a disk-backed OPFS
// adapter. This tests bounded reads/writes, not a browser compatibility claim.
globalThis.WorkerGlobalScope = class {}
const io = { largestRead: 0, largestWrite: 0 }
globalThis.FileReaderSync = class {
  readAsArrayBuffer ({ path, offset, length }) {
    io.largestRead = Math.max(io.largestRead, length)
    const bytes = new Uint8Array(length)
    const fd = openSync(path, 'r')
    try { assert.equal(readSync(fd, bytes, 0, length, offset), length) } finally { closeSync(fd) }
    return bytes.buffer
  }
}

function diskFile (path) {
  const size = statSync(path).size
  return {
    path,
    size,
    stream: () => Readable.toWeb(createReadStream(path, { highWaterMark: 65536 })),
    slice: (start, end) => ({ path, offset: start, length: Math.max(0, Math.min(end, size) - start), size: Math.max(0, Math.min(end, size) - start) })
  }
}

function directory (path, resources = { handles: new Set() }) {
  return {
    async getDirectoryHandle (name, { create } = {}) {
      const child = join(path, name)
      if (create) mkdirSync(child, { recursive: true })
      return directory(child, resources)
    },
    async removeEntry (name) { rmSync(join(path, name), { recursive: true }) },
    async getFileHandle (name, { create } = {}) {
      const child = join(path, name)
      if (create && !exists(child)) writeFileSync(child, '')
      return {
        async getFile () { return diskFile(child) },
        async createSyncAccessHandle () {
          const fd = openSync(child, 'r+')
          resources.handles.add(fd)
          return {
            truncate: size => ftruncateSync(fd, size),
            flush: () => fsyncSync(fd),
            close: () => { closeSync(fd); resources.handles.delete(fd) },
            read: (bytes, { at }) => readSync(fd, bytes, 0, bytes.length, at),
            write: (bytes, { at }) => {
              resources.beforeWrite?.(child)
              io.largestWrite = Math.max(io.largestWrite, bytes.length)
              return writeSync(fd, bytes, 0, bytes.length, at)
            }
          }
        }
      }
    }
  }
}

function exists (path) { try { statSync(path); return true } catch { return false } }
const newEngine = () => SevenZip({ stdin: () => null, print: () => {}, printErr: message => { if (process.env.ARCHIVE_DEBUG) console.error(message) } })
async function hash (path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function jobFor (context, archive, smallScreen = false, beforeWrite) {
  const root = mkdtempSync(join(tmpdir(), 'ifshare-archive-test-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const progress = []
  const resources = { handles: new Set(), beforeWrite, mounted: false }
  const createEngine = async () => {
    const engine = await newEngine()
    const mount = engine.FS.mount
    const unmount = engine.FS.unmount
    engine.FS.mount = (...args) => { const result = mount(...args); resources.mounted = true; return result }
    engine.FS.unmount = (...args) => { unmount(...args); resources.mounted = false }
    return engine
  }
  const job = createArchiveJob({ createEngine, getRoot: () => directory(root, resources), onProgress: value => progress.push(value) })
  await job.init({ session: 'test', smallScreen })
  for await (const bytes of createReadStream(archive, { highWaterMark: 1024 * 1024 })) job.append({ bytes })
  return { job, root, progress, resources }
}

for (const [name, format, count] of [['sample.zip', 'zip', 4], ['sample.tar.gz', 'tar.gz', 4], ['rar-v4.rar', 'rar', 4], ['rar-v5.rar', 'rar', 4]]) {
  test(`extracts ${name} completely before making files downloadable`, async context => {
    const { job, root, progress, resources } = await jobFor(context, resolve('test/fixtures/archives', name))
    await assert.rejects(job.page({ query: '', page: 0 }), { code: 'invalid' })
    await job.unpack({ format, password: '' })
    assert.equal(resources.handles.size, 0)
    assert.equal(resources.mounted, false)
    const page = await job.page({ query: '', page: 0 })
    assert.equal(page.count, count)
    for (const entry of page.entries) {
      const file = await job.file({ id: entry.id })
      assert.equal(file.size, entry.size)
      if (entry.path === 'hello.txt') assert.equal(readFileSync(file.path, 'utf8'), 'Hello IFShare\n')
      if (entry.path === '中文/说明.txt') assert.equal(readFileSync(file.path, 'utf8'), '本地解压\n')
    }
    assert.ok(progress.some(value => value.phase === 'extracting' && value.completed === count))
    assert.equal(exists(join(root, 'ifshare-archives/test/input')), false)
    assert.equal(exists(join(root, 'ifshare-archives/test/payload')), false)
  })
}

for (const [format, password] of [['7z', ''], ['7z', 'ifshare-test-password'], ['zip', ''], ['tar.gz', ''], ['tar', '']]) {
  test(`extracts ${password ? 'encrypted ' : ''}${format} directories and preserves filenames and bytes`, async context => {
    const root = mkdtempSync(join(tmpdir(), 'ifshare-7z-test-'))
    context.after(() => rmSync(root, { recursive: true, force: true }))
    const expected = new Map([
      ['hello.txt', 'Hello IFShare\n'],
      ['中文/说明.txt', '本地解压\n'],
      ['nested/code.js', 'console.log("IFShare")\n'],
      ['empty.txt', '']
    ])
    for (const [path, contents] of expected) {
      const target = join(root, 'files', path)
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, contents)
    }
    mkdirSync(join(root, 'files', 'empty-directory'))
    const engine = await newEngine()
    engine.FS.mkdir('/source')
    engine.FS.mount(engine.NODEFS, { root }, '/source')
    engine.FS.chdir('/source/files')
    const options = password ? [`-p${password}`, '-mhe=on'] : []
    if (format === '7z') options.push('-ms=on', '-mx=1')
    const container = format === 'tar.gz' ? 'tar' : format
    assert.equal(engine.callMain(['a', `-t${container}`, '-bso0', '-bsp0', ...options, `/source/sample.${container}`, '.']), 0)
    if (format === 'tar.gz') assert.equal(engine.callMain(['a', '-tgzip', '-bso0', '-bsp0', '/source/sample.tar.gz', '/source/sample.tar']), 0)
    const archive = join(root, `sample.${format}`)
    assert.equal(detectArchiveFormat(readFileSync(archive).subarray(0, 512)), format)
    if (password) {
      const incorrect = await jobFor(context, archive)
      await assert.rejects(incorrect.job.unpack({ format: '7z', password: 'incorrect' }), { code: 'failed' })
      assert.equal(incorrect.resources.handles.size, 0)
      assert.equal(incorrect.resources.mounted, false)
      process.exitCode = 0
    }
    const { job, progress, resources } = await jobFor(context, archive)
    await job.unpack({ format, password })
    assert.equal(resources.handles.size, 0)
    assert.equal(resources.mounted, false)
    const page = await job.page({ query: '', page: 0 })
    assert.equal(page.count, expected.size)
    for (const entry of page.entries) {
      assert.ok(expected.has(entry.path), `unexpected file: ${entry.path}`)
      const file = await job.file({ id: entry.id })
      assert.equal(readFileSync(file.path, 'utf8'), expected.get(entry.path))
    }
    assert.ok(progress.some(value => value.phase === 'extracting' && value.completed === expected.size))
  })
}

for (const format of ['zip', '7z']) {
  test(`desktop extracts a 128 MiB ${format} with bounded disk I/O; small screens reject it`, async context => {
    const root = mkdtempSync(join(tmpdir(), 'ifshare-large-archive-'))
    context.after(() => rmSync(root, { recursive: true, force: true }))
    const fd = openSync(join(root, 'large.bin'), 'w')
    ftruncateSync(fd, 128 * 1024 * 1024)
    closeSync(fd)
    const engine = await newEngine()
    engine.FS.mkdir('/source')
    engine.FS.mount(engine.NODEFS, { root }, '/source')
    assert.equal(engine.callMain(['a', `-t${format}`, '-mx=1', '-bso0', '-bsp0', `/source/large.${format}`, '/source/large.bin']), 0)
    const desktop = await jobFor(context, join(root, `large.${format}`))
    await desktop.job.unpack({ format, password: '' })
    const output = await desktop.job.file({ id: 0 })
    assert.equal(output.size, 128 * 1024 * 1024)
    assert.equal(await hash(output.path), await hash(join(root, 'large.bin')))
    assert.ok(io.largestRead <= 4 * 1024 * 1024, `read allocated ${io.largestRead} bytes`)
    assert.ok(io.largestWrite <= 1024 * 1024, `write buffered ${io.largestWrite} bytes`)
    const mobile = await jobFor(context, join(root, `large.${format}`), true)
    await assert.rejects(mobile.job.unpack({ format, password: '' }), { code: 'tooLarge' })
    assert.equal(mobile.resources.handles.size, 0)
    assert.equal(mobile.resources.mounted, false)
    // Emscripten's Node wrapper sets the process exit code for this expected
    // exception. Browser workers have no process exit code.
    process.exitCode = 0
  })
}

test('releases handles when engine initialization fails', async context => {
  const root = mkdtempSync(join(tmpdir(), 'ifshare-init-failure-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const resources = { handles: new Set() }
  const job = createArchiveJob({
    createEngine: async () => { throw new Error('Engine unavailable') },
    getRoot: () => directory(root, resources),
    onProgress: () => {}
  })
  await assert.rejects(job.init({ session: 'test', smallScreen: false }), /Engine unavailable/)
  assert.equal(resources.handles.size, 0)
})

test('releases input on invalid signatures and all handles after an output quota failure', async context => {
  const invalid = await jobFor(context, resolve('test/fixtures/archives/sample.zip'))
  await assert.rejects(invalid.job.unpack({ format: 'rar', password: '' }), { code: 'invalid' })
  assert.equal(invalid.resources.handles.size, 0)
  assert.equal(invalid.resources.mounted, false)
  const full = await jobFor(context, resolve('test/fixtures/archives/sample.zip'), false, path => {
    if (/file-\d+$/.test(path)) throw new DOMException('Disk full', 'QuotaExceededError')
  })
  await assert.rejects(full.job.unpack({ format: 'zip', password: '' }), { name: 'QuotaExceededError' })
  assert.equal(full.resources.handles.size, 0)
  assert.equal(full.resources.mounted, false)
  await assert.rejects(full.job.page({ query: '', page: 0 }), { code: 'invalid' })
  process.exitCode = 0
})

test('rejects gzipped text instead of claiming it is a TAR archive', async context => {
  const root = mkdtempSync(join(tmpdir(), 'ifshare-gzip-test-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = await newEngine()
  engine.FS.writeFile('/notes.txt', new TextEncoder().encode('not a tar archive'))
  assert.equal(engine.callMain(['a', '-tgzip', '-bso0', '-bsp0', '/notes.gz', '/notes.txt']), 0)
  const path = join(root, 'notes.gz')
  writeFileSync(path, engine.FS.readFile('/notes.gz'))
  const { job, resources } = await jobFor(context, path)
  await assert.rejects(job.unpack({ format: 'tar.gz', password: '' }), { code: 'failed' })
  assert.equal(resources.handles.size, 0)
  assert.equal(resources.mounted, false)
  await assert.rejects(job.page({ query: '', page: 0 }), { code: 'invalid' })
  process.exitCode = 0
})

test('extracts the TAR writer output used by IFShare multi-file downloads', async context => {
  const { job, root, resources } = await jobFor(context, resolve('test/fixtures/archives/ifshare-multiple.tar'))
  await job.unpack({ format: 'tar', password: '' })
  const page = await job.page({ query: '', page: 0 })
  assert.equal(page.count, 4)
  const expected = new Map([
    ['hello.txt', 'Hello IFShare\n'],
    ['说明.txt', '多文件下载\n'],
    ['empty.txt', ''],
    ['long-name-' + 'a'.repeat(100) + '.js', 'console.log("TAR preview")\n']
  ])
  for (const entry of page.entries) {
    assert.ok(expected.has(entry.name))
    const file = await job.file({ id: entry.id })
    assert.equal(readFileSync(file.path, 'utf8'), expected.get(entry.name))
  }
  assert.equal(resources.handles.size, 0)
  assert.equal(resources.mounted, false)
  assert.equal(exists(join(root, 'ifshare-archives/test/input')), false)
})

test('shows empty TARs without identifying arbitrary zero-filled files as TAR', async context => {
  const root = mkdtempSync(join(tmpdir(), 'ifshare-empty-tar-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  for (const size of [1024, 10240]) {
    const path = join(root, `empty-${size}.tar`)
    const bytes = new Uint8Array(size)
    writeFileSync(path, bytes)
    assert.equal(detectArchiveFormat(bytes), null)
    const { job, resources } = await jobFor(context, path)
    await job.unpack({ format: 'tar', password: '' })
    assert.deepEqual(await job.page({ query: '', page: 0 }), { entries: [], count: 0 })
    assert.equal(resources.handles.size, 0)
    assert.equal(resources.mounted, false)
  }
})

test('rejects invalid padding after empty TAR markers and releases the input handle', async context => {
  const root = mkdtempSync(join(tmpdir(), 'ifshare-invalid-tar-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const bytes = new Uint8Array(2048)
  bytes[1600] = 1
  const path = join(root, 'invalid.tar')
  writeFileSync(path, bytes)
  const { job, resources } = await jobFor(context, path)
  await assert.rejects(job.unpack({ format: 'tar', password: '' }), { code: 'invalid' })
  assert.equal(resources.handles.size, 0)
  assert.equal(resources.mounted, false)
})

test('checks TAR header checksums before routing binary files to extraction', () => {
  const header = readFileSync('test/fixtures/archives/ifshare-multiple.tar').subarray(0, 512)
  assert.equal(detectArchiveFormat(header), 'tar')
  assert.equal(detectArchiveFormat(header.subarray(0, 511)), null)
  const corrupt = Uint8Array.from(header)
  corrupt[0] ^= 1
  assert.equal(detectArchiveFormat(corrupt), null)
  assert.throws(() => checkSignature(corrupt, 'tar'), { code: 'invalid' })
  assert.throws(() => checkSignature(new Uint8Array(512), 'tar'), { code: 'invalid' })
})

test('detects only complete supported signatures and rejects mismatches', () => {
  const samples = [
    ['zip', [0x50, 0x4b, 3, 4]],
    ['zip', [0x50, 0x4b, 5, 6]],
    ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0]],
    ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 7, 1, 0]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['tar.gz', [0x1f, 0x8b, 8]]
  ]
  for (const [format, signature] of samples) {
    const bytes = Uint8Array.from(signature)
    assert.equal(detectArchiveFormat(bytes), format)
    assert.doesNotThrow(() => checkSignature(bytes, format))
    assert.equal(detectArchiveFormat(bytes.subarray(0, bytes.length - 1)), null)
    assert.throws(() => checkSignature(bytes, format === 'zip' ? 'rar' : 'zip'), { code: 'invalid' })
  }
  assert.equal(detectArchiveFormat(new TextEncoder().encode('normal text')), null)
  assert.throws(() => checkSignature(new Uint8Array(), null), { code: 'invalid' })
})

test('manifest pages retain only 50 entries and search all paths', async () => {
  const lines = Array.from({ length: 175 }, (_, id) => JSON.stringify({ id, path: `nested/file-${id}.js`, size: 0, name: `file-${id}.js` })).join('\n') + '\n'
  const file = new Blob([lines])
  const page = await manifestPage(file, '', 2)
  assert.equal(page.count, 175)
  assert.equal(page.entries.length, 50)
  assert.equal(page.entries[0].id, 100)
  assert.equal((await manifestPage(file, 'file-174', 0)).entries[0].id, 174)
})
