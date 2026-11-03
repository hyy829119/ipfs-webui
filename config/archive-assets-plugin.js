import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const archiveFiles = [
  ...['7zz.es6.js', '7zz.wasm', 'License.txt', 'unRarLicense.txt'].map(name => ({ name, path: require.resolve(`7z-wasm/${name}`) })),
  ...['archive-worker.js', 'archive-engine.js', 'archive-job.js'].map(name => ({ name, path: fileURLToPath(new URL(`../src/files/file-preview/archive/${name}`, import.meta.url)) }))
]

export default class ArchiveAssetsPlugin {
  constructor (files = archiveFiles) {
    this.files = files
  }

  apply (compiler) {
    const { webpack } = compiler
    const fileDependencies = this.files.map(file => file.path)
    let directory

    compiler.hooks.thisCompilation.tap('IFShareArchiveAssets', compilation => {
      // Snapshot each compilation, not the dev server's startup. The worker is
      // copied as native modules, so webpack must explicitly watch its sources.
      const assets = this.files.map(file => ({ name: file.name, bytes: readFileSync(file.path) }))
      const revision = createHash('sha256').update(Buffer.concat(assets.map(asset => asset.bytes))).digest('hex').slice(0, 16)
      directory = `static/archive/${revision}`
      const assetDirectory = directory
      for (const path of fileDependencies) compilation.fileDependencies.add(path)
      compilation.hooks.processAssets.tap({ name: 'IFShareArchiveAssets', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, () => {
        for (const { name, bytes } of assets) {
          compilation.emitAsset(`${assetDirectory}/${name}`, new webpack.sources.RawSource(bytes))
        }
      })
    })

    new webpack.DefinePlugin({
      __IFSHARE_ARCHIVE_WORKER_URL__: webpack.DefinePlugin.runtimeValue(
        () => JSON.stringify(`./${directory}/archive-worker.js`),
        { fileDependencies, version: () => directory }
      )
    }).apply(compiler)
  }
}
