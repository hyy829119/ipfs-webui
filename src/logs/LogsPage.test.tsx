import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeAll, beforeEach, expect, it, jest } from '@jest/globals'
import { createInstance } from 'i18next'
import ICU from 'i18next-icu'
import { I18nextProvider } from 'react-i18next'
import LogsPage from './LogsPage'
import { useSession } from '../auth/AuthGate'
import { apiRequest, ApiError, User } from '../auth/server-auth'
import en from '../../public/locales/en/logs.json'
import errors from '../../public/locales/en/users.json'

jest.mock('../auth/AuthGate', () => ({ useSession: jest.fn() }))
jest.mock('../auth/server-auth', () => ({ ...jest.requireActual<typeof import('../auth/server-auth')>('../auth/server-auth'), apiRequest: jest.fn() }))
const i18n = createInstance()
const request = apiRequest as jest.MockedFunction<(path: string, init?: Parameters<typeof apiRequest>[1]) => Promise<unknown>>
const session = useSession as jest.MockedFunction<typeof useSession>
const user: User = { id: 1, username: 'admin', displayName: 'Admin', role: 'admin', enabled: true, createdAt: '', updatedAt: '', lastLoginAt: null }
const log = { id: 1, username: 'alice', action: 'upload', fileName: 'report.pdf', filePath: '/report.pdf', cid: 'bafy-example', fileCount: 3, createdAt: '2026-11-10T00:00:00.000Z' }
function open () { return render(<I18nextProvider i18n={i18n}><LogsPage /></I18nextProvider>) }
function deferred<T> () {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}
beforeAll(async () => { await i18n.use(ICU).init({ lng: 'en', resources: { en: { logs: en, users: errors } }, interpolation: { escapeValue: false } }) })
beforeEach(() => {
  jest.clearAllMocks()
  session.mockReturnValue({ user, logout: async () => {} })
  request.mockResolvedValue({ logs: [log], total: 45, page: 1, pageSize: 20 })
})

it('renders operation metadata and changes pages using the server query', async () => {
  open()
  expect(await screen.findByText('report.pdf')).toBeInTheDocument()
  expect(screen.getByText('alice')).toBeInTheDocument()
  expect(screen.getByText('45 records')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })) })
  expect(request).toHaveBeenLastCalledWith('/logs?page=2&pageSize=20&q=&action=', expect.objectContaining({ signal: expect.anything() }))
})
it('resets pagination when searching or filtering and lets the server enforce viewer scope', async () => {
  session.mockReturnValue({ user: { ...user, role: 'user' }, logout: async () => {} })
  open()
  await screen.findByText('report.pdf')
  expect(screen.getByText('View your file operations.')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'report.pdf' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Search', exact: true })) })
  expect(request).toHaveBeenLastCalledWith('/logs?page=1&pageSize=20&q=report.pdf&action=', expect.anything())
  await act(async () => { fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'download' } }) })
  expect(request).toHaveBeenLastCalledWith('/logs?page=1&pageSize=20&q=report.pdf&action=download', expect.anything())
  await act(async () => { fireEvent.change(screen.getByLabelText('Per page'), { target: { value: '50' } }) })
  expect(request).toHaveBeenLastCalledWith('/logs?page=1&pageSize=50&q=report.pdf&action=download', expect.anything())
})
it('shows a localized load error and allows refreshing', async () => {
  request.mockRejectedValueOnce(new ApiError('server detail must not leak', 500, 'INTERNAL_ERROR'))
  open()
  expect(await screen.findByRole('alert')).not.toHaveTextContent('server detail')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })) })
  expect(await screen.findByText('report.pdf')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
it('cancels pending loads on unmount and displays an empty result', async () => {
  request.mockResolvedValue({ logs: [], total: 0, page: 1, pageSize: 20 })
  const view = open()
  await screen.findByText('No matching operations.')
  const signal = request.mock.calls[0][1]?.signal
  expect(signal?.aborted).toBe(false)
  view.unmount()
  await waitFor(() => expect(signal?.aborted).toBe(true))
})

it('aborts superseded queries and ignores their late results', async () => {
  const stale = deferred<unknown>()
  request.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ logs: [{ ...log, fileName: 'new-result.txt' }], total: 1, page: 1, pageSize: 20 })
  open()
  const firstSignal = request.mock.calls[0][1]?.signal
  fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'download' } })
  expect(await screen.findByText('new-result.txt')).toBeInTheDocument()
  expect(firstSignal?.aborted).toBe(true)
  await act(async () => { stale.resolve({ logs: [log], total: 999, page: 1, pageSize: 20 }) })
  expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  expect(screen.queryByText('999 records')).not.toBeInTheDocument()
  expect(screen.getByText('new-result.txt')).toBeInTheDocument()
})

it.each(['user', 'role'])('hides the previous rows and totals immediately when the %s scope changes, even if loading fails', async kind => {
  const view = open()
  await screen.findByText('report.pdf')
  const pending = deferred<unknown>()
  request.mockReturnValue(pending.promise)
  session.mockReturnValue({ user: { ...user, id: kind === 'user' ? 2 : user.id, role: 'user' }, logout: async () => {} })
  view.rerender(<I18nextProvider i18n={i18n}><LogsPage /></I18nextProvider>)
  expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  expect(screen.queryByText('45 records')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  expect(request).toHaveBeenCalledTimes(2)
  await act(async () => { pending.reject(new Error('offline')) })
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.queryByText('45 records')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})

it('refetches the last valid page once when the result count shrinks', async () => {
  request
    .mockResolvedValueOnce({ logs: [log], total: 45, page: 1, pageSize: 20 })
    .mockResolvedValueOnce({ logs: [log], total: 45, page: 2, pageSize: 20 })
    .mockResolvedValueOnce({ logs: [], total: 1, page: 3, pageSize: 20 })
    .mockResolvedValueOnce({ logs: [log], total: 1, page: 1, pageSize: 20 })
  open()
  await screen.findByText('1 / 3')
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText('2 / 3')
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(await screen.findByText('1 / 1')).toBeInTheDocument()
  expect(request).toHaveBeenCalledTimes(4)
  expect(request).toHaveBeenLastCalledWith('/logs?page=1&pageSize=20&q=&action=', expect.anything())
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})

it('aborts an unfinished request on unmount and ignores a late rejection', async () => {
  const pending = deferred<unknown>()
  request.mockReturnValue(pending.promise)
  const view = open()
  const signal = request.mock.calls[0][1]?.signal
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.reject(new Error('late failure')) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('shows a pending state when the same search is submitted again', async () => {
  open()
  await screen.findByText('report.pdf')
  const pending = deferred<unknown>()
  request.mockReturnValue(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Search', exact: true }))
  expect(screen.getByRole('status')).toHaveTextContent('Loading logs')
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  await act(async () => { pending.resolve({ logs: [], total: 0, page: 1, pageSize: 20 }) })
  expect(screen.getByText('No matching operations.')).toBeInTheDocument()
})
