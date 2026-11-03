import { BrowserArchive } from './archive-client'

function worker () {
  const listeners = new Map()
  return {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    postMessage: jest.fn(),
    terminate: jest.fn(),
    message: data => listeners.get('message')?.({ data }),
    fail: () => listeners.get('error')?.()
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
  await Promise.resolve()
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

it('shares cleanup across repeated closes and retries a temporarily locked directory', async () => {
  removeEntry.mockRejectedValueOnce(new DOMException('File is busy', 'NoModificationAllowedError'))
  const target = worker()
  const client = new BrowserArchive(() => {}, target)
  const closing = client.close()
  expect(client.close()).toBe(closing)
  await jest.runAllTimersAsync()
  await closing
  expect(target.terminate).toHaveBeenCalledTimes(1)
  expect(removeEntry).toHaveBeenCalledTimes(2)
  await expect(client.page('', 0)).rejects.toMatchObject({ code: 'cancelled' })
})

it('terminates a failed worker, rejects pending downloads and removes temporary files', async () => {
  const target = worker()
  const client = new BrowserArchive(() => {}, target)
  const pending = expect(client.file(0)).rejects.toMatchObject({ code: 'unsupported' })
  target.fail()
  await pending
  await client.close()
  expect(target.terminate).toHaveBeenCalledTimes(1)
  expect(removeEntry).toHaveBeenCalledTimes(1)
})

it('cancels initialization without sending work to a terminated worker', async () => {
  const target = worker()
  const client = new BrowserArchive(() => {}, target)
  const pending = expect(client.init(false)).rejects.toMatchObject({ code: 'cancelled' })
  await client.close()
  await pending
  expect(target.postMessage).not.toHaveBeenCalled()
  expect(jest.getTimerCount()).toBe(0)
})
