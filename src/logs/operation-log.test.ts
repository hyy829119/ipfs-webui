import { afterEach, beforeEach, expect, it, jest } from '@jest/globals'
import * as auth from '../auth/server-auth'
import { recordFileOperation, recordFilesOperation } from './operation-log'

let clock = 0
beforeEach(() => {
  clock += 60000
  jest.spyOn(Date, 'now').mockReturnValue(clock)
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(auth, 'apiRequest').mockResolvedValue({ log: {} })
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

it('sends one bounded request immediately, with a unique event and no client identity', async () => {
  const pending = recordFileOperation('preview', { fileName: 'main.js', filePath: '/files/main.js', cid: { toString: () => 'cid-1' } })
  expect(auth.apiRequest).toHaveBeenCalledTimes(1)
  const [path, request] = jest.mocked(auth.apiRequest).mock.calls[0]
  expect(path).toBe('/logs')
  expect(request).toMatchObject({ method: 'POST', keepalive: true, signal: expect.any(AbortSignal) })
  const body = JSON.parse(String(request?.body))
  expect(body).toEqual({
    eventId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    action: 'preview',
    fileName: 'main.js',
    filePath: '/files/main.js',
    cid: 'cid-1',
    fileCount: 1
  })
  await expect(pending).resolves.toBe(true)
  await recordFileOperation('preview', { fileName: 'main.js' })
  expect(JSON.parse(String(jest.mocked(auth.apiRequest).mock.calls[1][1]?.body)).eventId).not.toBe(body.eventId)
})

it('supports UUID generation when randomUUID is unavailable', async () => {
  const original = Object.getOwnPropertyDescriptor(window.crypto, 'randomUUID')
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: undefined })
  const random = jest.spyOn(window.crypto, 'getRandomValues')
  try {
    await recordFileOperation('download', { fileName: 'a.zip' })
    expect(random).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(jest.mocked(auth.apiRequest).mock.calls[0][1]?.body))
    expect(body.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  } finally {
    if (original) Object.defineProperty(window.crypto, 'randomUUID', original)
    else Reflect.deleteProperty(window.crypto, 'randomUUID')
  }
})

it('bounds metadata and counts, and removes control characters', async () => {
  await recordFileOperation('upload', { fileName: 'a'.repeat(255) + '😀', filePath: '/'.repeat(2000), cid: 'c'.repeat(300), fileCount: 2000000 })
  const body = JSON.parse(String(jest.mocked(auth.apiRequest).mock.calls[0][1]?.body))
  expect(body.fileName).toBe('a'.repeat(255))
  expect(body.filePath).toHaveLength(1024)
  expect(body.cid).toHaveLength(256)
  expect(body.fileCount).toBe(1000000)
  await recordFileOperation('upload', { fileName: 'a\u0000\nb', fileCount: -4 })
  expect(JSON.parse(String(jest.mocked(auth.apiRequest).mock.calls[1][1]?.body))).toMatchObject({ fileName: 'ab', fileCount: 1 })
})

it('records a batch as one event, keeps its destination, and ignores empty selections', async () => {
  await recordFilesOperation('upload', [{ path: 'folder/a.js' }, { path: 'folder/b.js' }], '/destination')
  expect(auth.apiRequest).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(jest.mocked(auth.apiRequest).mock.calls[0][1]?.body))).toMatchObject({
    action: 'upload', fileName: 'a.js', filePath: '/destination', fileCount: 2
  })
  await recordFilesOperation('download', [])
  expect(auth.apiRequest).toHaveBeenCalledTimes(1)
})

it('settles failed requests without retries or propagating rejection', async () => {
  jest.mocked(auth.apiRequest).mockRejectedValue(new Error('API unavailable'))
  await expect(recordFileOperation('download', { fileName: 'main.js' })).resolves.toBe(false)
  expect(auth.apiRequest).toHaveBeenCalledTimes(1)
  expect(console.warn).toHaveBeenCalledWith('[IFShare] File operation log could not be recorded.', { code: 'LOG_UNAVAILABLE', status: 0 })
})

it('reports bounded diagnostic categories without private metadata and rate-limits an outage', async () => {
  jest.mocked(auth.apiRequest).mockRejectedValue(new auth.ApiError('secret.txt /private/path cid-token admin', 503, 'private-server-detail'))
  await recordFileOperation('upload', { fileName: 'secret.txt', filePath: '/private/path', cid: 'cid-token' })
  await recordFileOperation('preview', { fileName: 'second-secret.txt' })
  expect(console.warn).toHaveBeenCalledTimes(1)
  expect(console.warn).toHaveBeenCalledWith('[IFShare] File operation log could not be recorded.', { code: 'LOG_HTTP_ERROR', status: 503 })
  expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toMatch(/secret|private|cid-token|admin/)
  jest.mocked(Date.now).mockReturnValue(clock + 30000)
  await recordFileOperation('download', { fileName: 'third-secret.txt' })
  expect(console.warn).toHaveBeenCalledTimes(2)
  expect(auth.apiRequest).toHaveBeenCalledTimes(3)
})

it('aborts a stalled request after three seconds and releases its timer', async () => {
  jest.useFakeTimers({ now: clock })
  jest.mocked(auth.apiRequest).mockImplementation((_path, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
  }))
  const pending = recordFileOperation('download', { fileName: 'main.js' })
  jest.advanceTimersByTime(3000)
  await expect(pending).resolves.toBe(false)
  expect(auth.apiRequest).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
  expect(console.warn).toHaveBeenCalledWith('[IFShare] File operation log could not be recorded.', { code: 'LOG_TIMEOUT', status: 0 })
})
