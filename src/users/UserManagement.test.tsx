import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { useSession } from '../auth/AuthGate'
import { apiRequest, ApiError, SESSION_EXPIRED_EVENT, User } from '../auth/server-auth'
import UserManagement from './UserManagement'
import { createInstance } from 'i18next'
import ICU from 'i18next-icu'
import { I18nextProvider } from 'react-i18next'
import en from '../../public/locales/en/users.json'
import zh from '../../public/locales/zh-CN/users.json'
import ar from '../../public/locales/ar/users.json'

jest.mock('../auth/AuthGate', () => ({ useSession: jest.fn() }))
jest.mock('../auth/server-auth', () => ({ ...jest.requireActual<typeof import('../auth/server-auth')>('../auth/server-auth'), apiRequest: jest.fn() }))

const i18n = createInstance()
beforeAll(async () => {
  await i18n.use(ICU).init({ lng: 'en', fallbackLng: 'en', resources: { en: { users: en }, 'zh-CN': { users: zh }, ar: { users: ar } }, interpolation: { escapeValue: false } })
})
function renderPage () {
  return render(<I18nextProvider i18n={i18n}><UserManagement /></I18nextProvider>)
}

const admin: User = { id: 1, username: 'admin', displayName: '管理员', role: 'admin', enabled: true, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', lastLoginAt: '2026-11-10T00:00:00.000Z' }
const member: User = { ...admin, id: 2, username: 'alice', displayName: '小林', role: 'user', lastLoginAt: null }
const mockSession = useSession as jest.MockedFunction<typeof useSession>
const mockRequest = apiRequest as jest.MockedFunction<(path: string, init?: Parameters<typeof apiRequest>[1]) => Promise<unknown>>

beforeEach(async () => {
  await i18n.changeLanguage('en')
  jest.clearAllMocks()
  mockSession.mockReturnValue({ user: admin, logout: async () => {} })
  mockRequest.mockImplementation(async (_path, init) => {
    if (!init?.method) return { users: [admin, member], total: 2, page: 1, pageSize: 20 }
    return { user: member }
  })
})

async function openPage () {
  renderPage()
  await screen.findByRole('button', { name: 'Edit alice' })
  await waitFor(() => expect(screen.queryByText('Loading users…')).not.toBeInTheDocument())
}

async function confirmDialog () {
  await act(async () => { userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' })) })
}

describe('user management access and listing', () => {
  it.each([member, null])('does not request users when the viewer is not an administrator', user => {
    mockSession.mockReturnValue({ user, logout: async () => {} })
    renderPage()
    expect(screen.getByRole('heading', { name: 'You cannot access user management' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '#/')
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('lists users and protects the built-in admin from removal, disabling or renaming', async () => {
    await openPage()
    expect(screen.getByText('2 users')).toBeInTheDocument()
    expect(screen.getByText('Never signed in')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete admin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable admin' })).not.toBeInTheDocument()
    userEvent.click(screen.getByRole('button', { name: 'Edit admin' }))
    expect(screen.getByLabelText('Username')).toBeDisabled()
    expect(screen.getByLabelText('Allow this user to sign in')).toBeDisabled()
    expect(screen.getByLabelText('Display name')).toBeEnabled()
  })

  it('sends search and pagination parameters to the server', async () => {
    await openPage()
    userEvent.type(screen.getByRole('searchbox'), 'alice')
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Search', exact: true })) })
    expect(mockRequest).toHaveBeenLastCalledWith('/users?q=alice&page=1&pageSize=20', expect.objectContaining({ signal: expect.anything() }))
  })

  it('displays a failed load and retries without a page reload', async () => {
    mockRequest.mockRejectedValueOnce(new Error('Unable to reach the service'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach the service')
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Try again' })) })
    expect(await screen.findByRole('button', { name: 'Edit alice' })).toBeInTheDocument()
  })
})

describe('user management operations', () => {
  it('creates a user without submitting a plaintext initial password or a client-controlled role', async () => {
    await openPage()
    userEvent.click(screen.getByRole('button', { name: 'Add user' }))
    userEvent.type(screen.getByLabelText('Username'), 'bob')
    userEvent.type(screen.getByLabelText('Display name'), '小明')
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mockRequest).toHaveBeenCalledWith('/users', { method: 'POST', body: JSON.stringify({ username: 'bob', displayName: '小明', enabled: true }) })
    expect(await screen.findByText('User created. The initial password is password.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits a user and keeps server validation failures in the form for correction', async () => {
    await openPage()
    userEvent.click(screen.getByRole('button', { name: 'Edit alice' }))
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } })
    mockRequest.mockRejectedValueOnce(new ApiError('用户名已存在', 409, 'USERNAME_EXISTS'))
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('This username is already in use.')
    expect(screen.getByLabelText('Username')).toHaveValue('bob')
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob2' } })
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mockRequest).toHaveBeenCalledWith('/users/2', { method: 'PATCH', body: JSON.stringify({ username: 'bob2', displayName: '小林', enabled: true }) })
    expect(await screen.findByText('User details updated.')).toBeInTheDocument()
  })

  it('requires confirmation before disabling a user and supports enabling again', async () => {
    await openPage()
    userEvent.click(screen.getByRole('button', { name: 'Disable alice' }))
    expect(mockRequest).not.toHaveBeenCalledWith('/users/2', expect.anything())
    mockRequest.mockImplementation(async (_path, init) => !init?.method
      ? { users: [admin, { ...member, enabled: false }], total: 2, page: 1, pageSize: 20 }
      : { user: { ...member, enabled: false } })
    await confirmDialog()
    expect(mockRequest).toHaveBeenCalledWith('/users/2', { method: 'PATCH', body: '{"enabled":false}' })
    userEvent.click(await screen.findByRole('button', { name: 'Enable alice' }))
    await confirmDialog()
    expect(mockRequest).toHaveBeenCalledWith('/users/2', { method: 'PATCH', body: '{"enabled":true}' })
  })

  it('resets a user password and explains that the user must sign in again', async () => {
    await openPage()
    userEvent.click(screen.getByRole('button', { name: 'Reset password for alice' }))
    await confirmDialog()
    expect(mockRequest).toHaveBeenCalledWith('/users/2/reset-password', { method: 'POST' })
    expect(await screen.findByText('Password reset to password. The user must sign in again.')).toBeInTheDocument()
  })

  it('immediately expires the current session after the administrator resets their own password', async () => {
    const expired = jest.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    try {
      await openPage()
      userEvent.click(screen.getByRole('button', { name: 'Reset password for admin' }))
      await confirmDialog()
      expect(mockRequest).toHaveBeenCalledWith('/users/1/reset-password', { method: 'POST' })
      expect(expired).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expired)
    }
  })

  it('cancels deletion without changing the account and deletes only after confirmation', async () => {
    await openPage()
    userEvent.click(screen.getByRole('button', { name: 'Delete alice' }))
    userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mockRequest).not.toHaveBeenCalledWith('/users/2', { method: 'DELETE' })
    userEvent.click(screen.getByRole('button', { name: 'Delete alice' }))
    await confirmDialog()
    expect(mockRequest).toHaveBeenCalledWith('/users/2', { method: 'DELETE' })
    expect(await screen.findByText('User deleted. Their sessions have been invalidated.')).toBeInTheDocument()
  })
})

it('updates open dialogs, validation errors and dates when the language changes without losing edits', async () => {
  await openPage()
  const date = new Date(admin.createdAt)
  expect(screen.getAllByText(date.toLocaleString('en', { hour12: false })).length).toBeGreaterThan(0)
  userEvent.click(screen.getByRole('button', { name: 'Edit alice' }))
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } })
  mockRequest.mockRejectedValueOnce(new ApiError('用户名已存在', 409, 'USERNAME_EXISTS'))
  await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Save' })) })
  expect(screen.getByRole('alert')).toHaveTextContent(en.errors.USERNAME_EXISTS)
  await act(async () => { await i18n.changeLanguage('zh-CN') })
  expect(screen.getByRole('dialog')).toHaveAccessibleName(zh.dialogs.edit)
  expect(screen.getByLabelText(zh.fields.username)).toHaveValue('bob')
  expect(screen.getByRole('alert')).toHaveTextContent(zh.errors.USERNAME_EXISTS)
  expect(screen.getAllByText(date.toLocaleString('zh-CN', { hour12: false })).length).toBeGreaterThan(0)
  await act(async () => { await i18n.changeLanguage('ar') })
  expect(screen.getByRole('dialog')).toHaveAttribute('dir', 'rtl')
  expect(screen.getByRole('alert')).toHaveTextContent(ar.errors.USERNAME_EXISTS)
  expect(screen.getByLabelText(ar.fields.username)).toHaveValue('bob')
  userEvent.click(screen.getByRole('button', { name: ar.cancel }))
  expect(screen.getByRole('region', { name: ar.title })).toHaveAttribute('dir', 'rtl')
})

it('translates an existing success notice after switching languages', async () => {
  await openPage()
  userEvent.click(screen.getByRole('button', { name: 'Reset password for alice' }))
  await confirmDialog()
  expect(await screen.findByText(en.notices.reset)).toBeInTheDocument()
  await act(async () => { await i18n.changeLanguage('zh-CN') })
  expect(screen.getByText(zh.notices.reset)).toBeInTheDocument()
})

it('uses a localized generic error for an unknown server error code', async () => {
  mockRequest.mockRejectedValueOnce(new ApiError('不应展示的服务端消息', 500, 'FUTURE_ERROR'))
  renderPage()
  expect(await screen.findByRole('alert')).toHaveTextContent(en.errors.REQUEST_FAILED)
  expect(screen.queryByText('不应展示的服务端消息')).not.toBeInTheDocument()
})
