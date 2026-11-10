import { afterEach, beforeEach, expect, it, jest } from '@jest/globals'
import { advanceSessionGeneration } from '../auth/server-auth'
import { addDroppedFiles } from './dropped-files'

beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { jest.restoreAllMocks() })

it('normalizes one dropped batch and calls the shared upload entry once', async () => {
  const files = [new File(['hello'], 'first.txt'), new File(['world'], 'second.txt')]
  const upload = jest.fn<() => Promise<void>>().mockResolvedValue()
  await addDroppedFiles(Promise.resolve(files), upload)
  expect(upload).toHaveBeenCalledTimes(1)
  expect(upload).toHaveBeenCalledWith(files.map(file => ({ path: file.name, size: file.size, content: file })))
})

it('discards directory enumeration that completes after a session transition, including the same account', async () => {
  let finish!: (files: File[]) => void
  const pending = new Promise<File[]>(resolve => { finish = resolve })
  const upload = jest.fn()
  const result = addDroppedFiles(pending, upload)
  advanceSessionGeneration()
  advanceSessionGeneration()
  finish([new File(['private'], 'old-session.txt')])
  await result
  expect(upload).not.toHaveBeenCalled()
  expect(console.warn).not.toHaveBeenCalled()
})

it('handles enumeration errors without leaking paths or leaving rejected event handlers', async () => {
  const upload = jest.fn()
  await expect(addDroppedFiles(Promise.reject(new Error('/private/secret.txt')), upload)).resolves.toBeUndefined()
  expect(upload).not.toHaveBeenCalled()
  expect(console.warn).toHaveBeenCalledWith('[IFShare] Dropped files could not be imported.')
})

it('settles a rejected upload callback without retrying or retaining the file batch', async () => {
  const upload = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('RPC unavailable'))
  await expect(addDroppedFiles(Promise.resolve([new File([], 'file.txt')]), upload)).resolves.toBeUndefined()
  expect(upload).toHaveBeenCalledTimes(1)
})
