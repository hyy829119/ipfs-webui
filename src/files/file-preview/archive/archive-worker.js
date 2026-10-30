/* global FileReaderSync */
import SevenZip from './7zz.es6.js'
import { archiveFailure } from './archive-engine.js'
import { createArchiveJob } from './archive-job.js'

const operations = createArchiveJob({
  createEngine: () => SevenZip({
    stdin: () => null,
    print: () => {},
    printErr: () => {},
    locateFile: name => new URL(name, import.meta.url).href
  }),
  getRoot: () => {
    if (!globalThis.navigator.storage?.getDirectory || typeof FileReaderSync === 'undefined') throw archiveFailure('unsupported')
    return globalThis.navigator.storage.getDirectory()
  },
  onProgress: progress => globalThis.postMessage({ progress })
})

globalThis.onmessage = async ({ data }) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(operations, data.method)) throw archiveFailure('invalid')
    const value = await operations[data.method](data.args)
    globalThis.postMessage({ id: data.id, value })
  } catch (error) {
    const code = error?.name === 'QuotaExceededError' ? 'storage' : error.code || 'failed'
    globalThis.postMessage({ id: data.id, error: code })
  }
}
