import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import webpack from 'webpack'
import ArchiveAssetsPlugin from '../../config/archive-assets-plugin.js'

test('worker-only edits rebuild the assets and cached client URL without restarting webpack', { timeout: 20000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'ifshare-archive-assets-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const worker = join(root, 'archive-worker.js')
  const engine = join(root, 'archive-engine.js')
  await writeFile(join(root, 'index.js'), 'export default __IFSHARE_ARCHIVE_WORKER_URL__')
  await writeFile(worker, "import './archive-engine.js'")
  await writeFile(engine, "export const formats = ['zip']")
  const compiler = webpack({
    mode: 'development',
    context: root,
    entry: './index.js',
    output: { path: join(root, 'dist'), filename: 'client.js' },
    devtool: false,
    cache: { type: 'memory' },
    plugins: [new ArchiveAssetsPlugin([
      { name: 'archive-worker.js', path: worker },
      { name: 'archive-engine.js', path: engine }
    ])]
  })
  const results = []
  let waiting
  const nextCompilation = () => results.length
    ? Promise.resolve(results.shift())
    : new Promise(resolve => { waiting = resolve })
  const watcher = compiler.watch({ aggregateTimeout: 10 }, (error, stats) => {
    const result = { error, stats }
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve(result)
    } else results.push(result)
  })
  context.after(async () => {
    await new Promise((resolve, reject) => watcher.close(error => error ? reject(error) : resolve()))
    await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()))
  })
  const checkCompilation = async () => {
    const { error, stats } = await nextCompilation()
    assert.ifError(error)
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }))
    const source = await readFile(join(root, 'dist/client.js'), 'utf8')
    const url = source.match(/\.\/static\/archive\/[a-f0-9]{16}\/archive-worker\.js/)?.[0]
    assert.ok(url, 'the client must reference the emitted worker')
    assert.equal(await readFile(join(root, 'dist', url), 'utf8'), await readFile(worker, 'utf8'))
    assert.equal(await readFile(join(root, 'dist', url.replace('archive-worker.js', 'archive-engine.js')), 'utf8'), await readFile(engine, 'utf8'))
    return url
  }
  const originalURL = await checkCompilation()
  await writeFile(engine, "export const formats = ['zip', 'tar']")
  const updatedURL = await checkCompilation()
  assert.notEqual(updatedURL, originalURL)
  await writeFile(worker, "import './archive-engine.js'\n// new worker protocol")
  const workerURL = await checkCompilation()
  assert.notEqual(workerURL, updatedURL)
})
