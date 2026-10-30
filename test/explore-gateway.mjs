import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import initHelia from '../node_modules/ipld-explorer-components/dist/lib/init-helia.js'
import { createExplorerBroker } from '../src/explore/gateway-broker.js'

test('the shipped explorer uses the injected local-first broker and validates returned blocks', async context => {
  const originalFetch = globalThis.fetch
  const originalStorage = globalThis.localStorage
  context.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage })
  globalThis.localStorage = { getItem: () => 'false' }
  const bytes = new TextEncoder().encode('IFShare inspector regression')
  const cid = CID.createV1(0x55, await sha256.digest(bytes))
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, credentials: options.credentials })
    return { ok: true, arrayBuffer: async () => url.startsWith('http://127.0.0.1') ? new Uint8Array([0]).buffer : bytes.buffer }
  }
  const helia = await initHelia({
    protocol: 'http', host: 'stale.example', port: 8080,
    blockBrokers: [createExplorerBroker(() => ({ local: 'http://127.0.0.1:8080', server: 'https://ifshare.example:3000' }))]
  })
  context.after(() => helia.stop())
  assert.deepEqual(await helia.blockstore.get(cid), bytes)
  assert.deepEqual(requests.map(request => request.credentials), ['omit', 'same-origin'])
  assert.ok(requests[0].url.startsWith('http://127.0.0.1:8080/ipfs/'))
  assert.ok(requests[1].url.startsWith('https://ifshare.example:3000/ipfs/'))
})
