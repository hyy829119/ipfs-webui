import { BrowserArchive } from './archive-client'

function worker () {
  const listeners = new Map()
  return {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    postMessage: jest.fn(),
    terminate: jest.fn(),
    message: data => listeners.get('message')({ data })
  }
}

let removeEntry
beforeEach(() => {
  jest.useFakeTimers()
  removeEntry = jest.fn().mockResolvedValue()
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ getDirectoryHandle: async () => ({ removeEntry }) }) } })
})
afterEach(() => jest.useRealTimers())

it('keeps an extraction running without a total deadline and forwards real progress', async () => {
  const target = worker()
  const progress = jest.fn()
  const client = new BrowserArchive(progress, target)
  const init = client.init(false)
  target.message({ id: 1 })
  await init
  const unpack = client.unpack('zip', '')
  jest.advanceTimersByTime(24 * 60 * 60 * 1000)
  expect(target.terminate).not.toHaveBeenCalled()
  target.message({ progress: { phase: 'extracting', loaded: 5, total: 10 } })
  expect(progress).toHaveBeenCalledWith({ phase: 'extracting', loaded: 5, total: 10 })
  target.message({ id: 2 })
  await unpack
  await client.close()
  expect(removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^archive-/), { recursive: true })
})

it('transfers input ownership and rejects pending requests when cancelled', async () => {
  const target = worker()
  const client = new BrowserArchive(() => {}, target)
  const bytes = new Uint8Array(1024)
  const pending = client.append(bytes)
  expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'append' }), [bytes.buffer])
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  await client.close()
  await rejected
  expect(target.terminate).toHaveBeenCalledTimes(1)
})
