import { createExplorerBroker } from './gateway-broker.js'

const local = 'http://127.0.0.1:8080'
const server = 'https://ifshare.example:3000'
const cid = { toString: () => 'bafk-test' }
const originalFetch = global.fetch
const response = bytes => ({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer })
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers() })

it('uses a verified local block without querying the server', async () => {
  global.fetch = jest.fn().mockResolvedValue(response([1, 2]))
  const validateFn = jest.fn()
  const block = await createExplorerBroker(() => ({ local, server }))().retrieve(cid, { validateFn })
  expect([...block]).toEqual([1, 2])
  expect(validateFn).toHaveBeenCalledWith(block)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith(`${local}/ipfs/bafk-test?format=raw`, expect.objectContaining({ credentials: 'omit' }))
})

it.each(['network', 'missing', 'corrupt'])('falls back to the authenticated server after a local %s failure', async failure => {
  global.fetch = jest.fn()
  if (failure === 'network') fetch.mockRejectedValueOnce(new TypeError('Blocked local network'))
  else fetch.mockResolvedValueOnce(failure === 'missing' ? { ok: false, status: 404 } : response([0]))
  fetch.mockResolvedValueOnce(response([3]))
  const validateFn = bytes => { if (bytes[0] === 0) throw new Error('CID mismatch') }
  const block = await createExplorerBroker(() => ({ local, server }))().retrieve(cid, { validateFn })
  expect([...block]).toEqual([3])
  expect(fetch).toHaveBeenLastCalledWith(`${server}/ipfs/bafk-test?format=raw`, expect.objectContaining({ credentials: 'same-origin' }))
})

it('times out a stalled local probe and continues with the server', async () => {
  jest.useFakeTimers()
  global.fetch = jest.fn().mockImplementationOnce((_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')))
  })).mockResolvedValueOnce(response([4]))
  const result = createExplorerBroker(() => ({ local, server }))().retrieve(cid)
  jest.advanceTimersByTime(1500)
  expect([...(await result)]).toEqual([4])
})

it('does not fall back after caller cancellation and reads current gateway settings each time', async () => {
  let current = { server }
  const broker = createExplorerBroker(() => current)()
  const controller = new AbortController()
  controller.abort()
  global.fetch = jest.fn().mockResolvedValue(response([1]))
  await expect(broker.retrieve(cid, { signal: controller.signal })).rejects.toThrow('cancelled')
  expect(fetch).not.toHaveBeenCalled()
  await broker.retrieve(cid)
  current = { server: 'https://updated.example' }
  await broker.retrieve(cid)
  expect(fetch).toHaveBeenLastCalledWith('https://updated.example/ipfs/bafk-test?format=raw', expect.anything())
})
