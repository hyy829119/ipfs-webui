import { afterEach, beforeEach, expect, it, jest } from '@jest/globals'
import { advanceSessionGeneration, apiRequest, ApiError, SESSION_EXPIRED_EVENT } from './server-auth'

const originalFetch = global.fetch
const unauthorized = () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Expired' } }) }) as Response
function deferred<T> () {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(_resolve => { resolve = _resolve })
  return { promise, resolve }
}

beforeEach(() => {
  advanceSessionGeneration()
  global.fetch = jest.fn<typeof fetch>()
  jest.spyOn(window, 'dispatchEvent')
})
afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
})

it('does not expire a newer session when an older request returns 401', async () => {
  const response = deferred<Response>()
  jest.mocked(global.fetch).mockReturnValue(response.promise)
  const pending = apiRequest('/logs').catch(error => error)
  advanceSessionGeneration()
  response.resolve(unauthorized())
  await expect(pending).resolves.toBeInstanceOf(ApiError)
  expect(window.dispatchEvent).not.toHaveBeenCalled()
})

it('rechecks the session generation after parsing a delayed 401 body', async () => {
  const body = deferred<object>()
  jest.mocked(global.fetch).mockResolvedValue({ ...unauthorized(), json: () => body.promise } as Response)
  const pending = apiRequest('/users').catch(error => error)
  await Promise.resolve()
  advanceSessionGeneration()
  body.resolve({ error: { code: 'UNAUTHORIZED' } })
  await expect(pending).resolves.toBeInstanceOf(ApiError)
  expect(window.dispatchEvent).not.toHaveBeenCalled()
})

it('still expires the current session when its request returns 401', async () => {
  jest.mocked(global.fetch).mockResolvedValue(unauthorized())
  await expect(apiRequest('/logs')).rejects.toBeInstanceOf(ApiError)
  expect(window.dispatchEvent).toHaveBeenCalledTimes(1)
  expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: SESSION_EXPIRED_EVENT }))
})

it('leaves authentication endpoint responses to their callers', async () => {
  jest.mocked(global.fetch).mockResolvedValue(unauthorized())
  await expect(apiRequest('/auth/session')).rejects.toBeInstanceOf(ApiError)
  expect(window.dispatchEvent).not.toHaveBeenCalled()
})
