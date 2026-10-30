import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, ftruncateSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import SevenZip from '7z-wasm'
import { createArchiveJob } from '../../src/files/file-preview/archive/archive-job.js'
import { manifestPage } from '../../src/files/file-preview/archive/archive-engine.js'

// Exercise the production job and real WASM/WORKERFS with a disk-backed OPFS
// adapter. This tests bounded reads/writes, not a browser compatibility claim.
globalThis.WorkerGlobalScope = class {}
let largestRead = 0
let largestWrite = 0
globalThis.FileReaderSync = class {
  readAsArrayBuffer ({ path, offset, length }) {
    largestRead = Math.max(largestRead, length)
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

function directory (path) {
  return {
    async getDirectoryHandle (name, { create } = {}) {
      const child = join(path, name)
      if (create) mkdirSync(child, { recursive: true })
      return directory(child)
    },
    async removeEntry (name) { rmSync(join(path, name), { recursive: true }) },
    async getFileHandle (name, { create } = {}) {
      const child = join(path, name)
      if (create && !exists(child)) writeFileSync(child, '')
      return {
        async getFile () { return diskFile(child) },
        async createSyncAccessHandle () {
          const fd = openSync(child, 'r+')
          return {
            truncate: size => ftruncateSync(fd, size),
            flush: () => fsyncSync(fd),
            close: () => closeSync(fd),
            read: (bytes, { at }) => readSync(fd, bytes, 0, bytes.length, at),
            write: (bytes, { at }) => {
              largestWrite = Math.max(largestWrite, bytes.length)
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
async function jobFor (context, archive, smallScreen = false) {
  const root = mkdtempSync(join(tmpdir(), 'ifshare-archive-test-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const progress = []
  const job = createArchiveJob({ createEngine: newEngine, getRoot: () => directory(root), onProgress: value => progress.push(value) })
  await job.init({ session: 'test', smallScreen })
  for await (const bytes of createReadStream(archive, { highWaterMark: 1024 * 1024 })) job.append({ bytes })
  return { job, root, progress }
}

for (const [name, format, count] of [['sample.zip', 'zip', 4], ['sample.tar.gz', 'tar.gz', 4], ['rar-v4.rar', 'rar', 4], ['rar-v5.rar', 'rar', 4]]) {
  test(`extracts ${name} completely before making files downloadable`, async context => {
    const { job, root, progress } = await jobFor(context, resolve('test/fixtures/archives', name))
    await assert.rejects(job.page({ query: '', page: 0 }), { code: 'invalid' })
    await job.unpack({ format, password: '' })
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

test('desktop extracts a 128 MiB file with bounded disk I/O; small screens reject it', async context => {
  const root = mkdtempSync(join(tmpdir(), 'ifshare-large-archive-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const fd = openSync(join(root, 'large.bin'), 'w')
  ftruncateSync(fd, 128 * 1024 * 1024)
  closeSync(fd)
  const engine = await newEngine()
  engine.FS.mkdir('/source')
  engine.FS.mount(engine.NODEFS, { root }, '/source')
  assert.equal(engine.callMain(['a', '-tzip', '-mx=1', '-bso0', '-bsp0', '/source/large.zip', '/source/large.bin']), 0)
  const desktop = await jobFor(context, join(root, 'large.zip'))
  await desktop.job.unpack({ format: 'zip', password: '' })
  const output = await desktop.job.file({ id: 0 })
  assert.equal(output.size, 128 * 1024 * 1024)
  assert.equal(await hash(output.path), await hash(join(root, 'large.bin')))
  assert.ok(largestRead <= 4 * 1024 * 1024, `read allocated ${largestRead} bytes`)
  assert.ok(largestWrite <= 1024 * 1024, `write buffered ${largestWrite} bytes`)
  const mobile = await jobFor(context, join(root, 'large.zip'), true)
  await assert.rejects(mobile.job.unpack({ format: 'zip', password: '' }), { code: 'tooLarge' })
  // Emscripten's Node wrapper sets the process exit code for this expected
  // exception. Browser workers have no process exit code.
  process.exitCode = 0
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
