import { readArchive } from './archive-source'
import { ArchiveError, MOBILE_ARCHIVE_BYTES, isSmallScreenDevice } from './archive-utils'
import { getArchiveFormat } from '../preview-type'

const source = { url: 'http://127.0.0.1:8080/ipfs/test', fallbackUrl: 'https://ifshare.example/ipfs/test', local: true, mime: '' }
const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks() })
const sink = () => ({ append: jest.fn().mockResolvedValue(), reset: jest.fn().mockResolvedValue() })
const signal = () => new AbortController().signal

it.each([['a.ZIP', 'zip'], ['a.RAR', 'rar'], ['a.TAR.GZ', 'tar.gz'], ['a.7z', null], ['a.tar', null], ['a.tgz', null], ['a.zip.txt', null]])('recognizes only the requested extensions: %s', (name, expected) => {
  expect(getArchiveFormat(name)).toBe(expected)
})

it('applies the limit to physical small touch devices, not a narrow desktop window', () => {
  Object.defineProperty(window.screen, 'width', { configurable: true, value: 390 })
  Object.defineProperty(window.screen, 'height', { configurable: true, value: 844 })
  window.matchMedia = jest.fn().mockReturnValue({ matches: false })
  expect(isSmallScreenDevice()).toBe(false)
  window.matchMedia.mockReturnValue({ matches: true })
  expect(isSmallScreenDevice()).toBe(true)
})

it('streams more than the mobile limit on desktop in awaited chunks of at most 1 MiB', async () => {
  const output = sink()
  let inFlight = 0
  let total = 0
  output.append.mockImplementation(async bytes => {
    expect(++inFlight).toBe(1)
    expect(bytes.length).toBeLessThanOrEqual(1024 * 1024)
    total += bytes.length
    await Promise.resolve()
    inFlight--
  })
  const read = async function * () { yield new Uint8Array(1024 * 1024) }
  await readArchive({ ...source, url: '' }, read, MOBILE_ARCHIVE_BYTES + 1024 * 1024, false, output, signal(), () => {})
  expect(total).toBe(MOBILE_ARCHIVE_BYTES + 1024 * 1024)
  await expect(readArchive(source, read, total, true, output, signal(), () => {})).rejects.toMatchObject({ code: 'tooLarge' })
})

it('clears partially read local bytes and uses bounded server RPC reads', async () => {
  const reader = {
    read: jest.fn().mockResolvedValueOnce({ value: new Uint8Array([9, 9]), done: false }).mockRejectedValue(new Error('Disconnected')),
    cancel: jest.fn(),
    releaseLock: jest.fn()
  }
  global.fetch = jest.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } })
  const output = sink()
  const read = jest.fn(async function * () { yield new Uint8Array([1, 2, 3]) })
  const result = await readArchive(source, read, 3, false, output, signal(), () => {})
  expect(output.reset).toHaveBeenCalledTimes(1)
  expect([...output.append.mock.calls[1][0]]).toEqual([1, 2, 3])
  expect(read).toHaveBeenCalledWith(0, 1024 * 1024, expect.anything())
  expect(result.local).toBe(false)
  expect(result.url).toBe(source.fallbackUrl)
  expect(reader.releaseLock).toHaveBeenCalled()
})

it('does not retry a quota failure or continue after cancellation', async () => {
  const output = sink()
  output.append.mockRejectedValue(new ArchiveError('storage'))
  global.fetch = jest.fn().mockResolvedValue({ ok: true, body: { getReader: () => ({ read: async () => ({ value: new Uint8Array([1]), done: false }), cancel: jest.fn(), releaseLock: jest.fn() }) } })
  const read = jest.fn()
  await expect(readArchive(source, read, 1, false, output, signal(), () => {})).rejects.toMatchObject({ code: 'storage' })
  expect(read).not.toHaveBeenCalled()
  const controller = new AbortController()
  controller.abort()
  await expect(readArchive({ ...source, url: '' }, read, 1, false, output, controller.signal, () => {})).rejects.toMatchObject({ code: 'cancelled' })
})
