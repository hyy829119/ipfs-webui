import React, { useEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { AccountMenu, AuthGate } from './AuthGate'
import * as auth from './server-auth'
import { NavBar } from '../navigation/NavBar.js'
import translations from '../../public/locales/en/login.json'
import usersTranslations from '../../public/locales/en/users.json'

jest.mock('react-helmet', () => ({ Helmet: () => null }))

const i18n = createInstance()
const admin: auth.User = { id: 1, username: 'admin', displayName: '管理员', role: 'admin', enabled: true, createdAt: '', updatedAt: '', lastLoginAt: null }
const originalFetch = global.fetch
const unauthorized = () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'UNAUTHORIZED' } }) }) as Response
function deferred<T> () {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(_resolve => { resolve = _resolve })
  return { promise, resolve }
}

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { login: translations, users: usersTranslations } }, interpolation: { escapeValue: false } })
})
beforeEach(() => {
  window.sessionStorage.clear()
  jest.spyOn(auth, 'readServerSession').mockResolvedValue(null)
  jest.spyOn(auth, 'signInOnServer').mockResolvedValue(admin)
  jest.spyOn(auth, 'signOutOnServer').mockResolvedValue()
})
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks() })

function Workspace ({ initialHash = '/files/private' }: { initialHash?: string }) {
  const [hash, setHash] = useState(initialHash)
  return (
    <I18nextProvider i18n={i18n}>
      <AuthGate hash={hash} doUpdateHash={setHash}>
        <h1>Private workspace</h1>
        <span data-testid='workspace-route'>{hash}</span>
        <NavBar t={i18n.t} />
        <AccountMenu />
      </AuthGate>
    </I18nextProvider>
  )
}

async function submitCredentials (username = 'admin', password = 'password') {
  await screen.findByRole('button', { name: 'Enter workspace' })
  userEvent.type(screen.getByLabelText('Username', { exact: true }), username)
  userEvent.type(screen.getByLabelText('Password', { exact: true }), password)
  await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Enter workspace' })) })
}

describe('server authenticated workspace', () => {
  it('does not mount private content or trust an old forged browser session', async () => {
    window.sessionStorage.setItem('ifshare.session.v1', 'admin')
    render(<Workspace />)
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
  })

  it('logs in through the API, opens home and shows administrator navigation', async () => {
    render(<Workspace />)
    await submitCredentials()
    expect(auth.signInOnServer).toHaveBeenCalledWith('admin', 'password')
    expect(screen.getByTestId('workspace-route')).toHaveTextContent(/^\/$/)
    expect(screen.getByRole('menuitem', { name: 'Users' })).toBeInTheDocument()
    expect(within(screen.getByRole('menubar')).getAllByRole('menuitem').map(item => item.getAttribute('href'))).toEqual(['#/', '#/files', '#/explore', '#/peers', '#/users', '#/logs', '#/settings'])
    expect(screen.getByText('管理员')).toBeInTheDocument()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('restores the server session and preserves the current route', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    render(<Workspace initialHash='/users' />)
    expect(await screen.findByText('Private workspace')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-route')).toHaveTextContent('/users')
  })

  it('shows the actual user and hides user management for ordinary users', async () => {
    jest.mocked(auth.signInOnServer).mockResolvedValue({ ...admin, id: 2, username: 'alice', displayName: 'Alice', role: 'user' })
    render(<Workspace />)
    await submitCredentials('alice')
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Users' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('menubar')).getAllByRole('menuitem').map(item => item.getAttribute('href'))).toEqual(['#/', '#/files', '#/explore', '#/peers', '#/logs', '#/settings'])
  })

  it('rejects credentials that the API rejects', async () => {
    jest.mocked(auth.signInOnServer).mockResolvedValue(null)
    render(<Workspace />)
    await submitCredentials('admin', 'wrong')
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect username or password')
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Password', { exact: true }), { target: { value: 'password' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows service errors and allows retry', async () => {
    jest.mocked(auth.signInOnServer).mockRejectedValue(new Error('Network unavailable'))
    render(<Workspace />)
    await submitCredentials()
    expect(screen.getByRole('alert')).toHaveTextContent(usersTranslations.errors.NETWORK_ERROR)
    expect(screen.getByRole('button', { name: 'Enter workspace' })).toBeEnabled()
  })

  it('explains unsupported secure login without falling back to plaintext', async () => {
    jest.mocked(auth.signInOnServer).mockRejectedValue(new auth.ApiError('请使用 HTTPS', 0, 'CRYPTO_UNAVAILABLE'))
    render(<Workspace />)
    await submitCredentials()
    expect(screen.getByRole('alert')).toHaveTextContent(usersTranslations.errors.CRYPTO_UNAVAILABLE)
  })

  it('clears a revoked session and closes the private workspace', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    act(() => { window.dispatchEvent(new Event(auth.SESSION_EXPIRED_EVENT)) })
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
  })

  it('rechecks disablement when the window regains focus', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValueOnce(admin).mockResolvedValue(null)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('does not discard a session on a transient network error', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValueOnce(admin).mockRejectedValue(new Error('offline'))
    render(<Workspace />)
    await screen.findByText('Private workspace')
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
  })

  it('logs out through the service before closing the workspace', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(auth.signOutOnServer).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('keeps logout retryable if the service cannot invalidate the cookie', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    jest.mocked(auth.signOutOnServer).mockRejectedValue(new Error('offline'))
    render(<Workspace />)
    await screen.findByText('Private workspace')
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to sign out')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
  })

  it.each([
    admin,
    { ...admin, id: 2, username: 'alice', displayName: 'Alice', role: 'user' as const }
  ])('keeps a new login for $username when a previous login request returns 401', async nextUser => {
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    const oldResponse = deferred<Response>()
    global.fetch = jest.fn<typeof fetch>().mockReturnValue(oldResponse.promise)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    const oldRequest = auth.apiRequest('/logs', { method: 'POST', body: '{}' }).catch(error => error)

    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('button', { name: 'Enter workspace' })
    jest.mocked(auth.signInOnServer).mockResolvedValue(nextUser)
    await submitCredentials(nextUser.username)
    expect(screen.getByText(nextUser.displayName)).toBeInTheDocument()

    await act(async () => { oldResponse.resolve(unauthorized()); await oldRequest })
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
    expect(screen.getByText(nextUser.displayName)).toBeInTheDocument()

    jest.mocked(global.fetch).mockResolvedValue(unauthorized())
    await act(async () => { await auth.apiRequest('/logs').catch(() => {}) })
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('ignores a pre-logout session check while logout is pending', async () => {
    const check = deferred<auth.User | null>()
    const logout = deferred<void>()
    jest.mocked(auth.readServerSession).mockResolvedValueOnce(admin).mockReturnValue(check.promise)
    jest.mocked(auth.signOutOnServer).mockReturnValue(logout.promise)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    act(() => { window.dispatchEvent(new Event('focus')) })
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await act(async () => { check.resolve(null) })
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enter workspace' })).not.toBeInTheDocument()
    await act(async () => { logout.resolve() })
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('does not advance the generation when a poll returns the same user', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    const response = deferred<Response>()
    global.fetch = jest.fn<typeof fetch>().mockReturnValue(response.promise)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    const generation = auth.getSessionGeneration()
    const request = auth.apiRequest('/logs').catch(error => error)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(auth.getSessionGeneration()).toBe(generation)
    await act(async () => { response.resolve(unauthorized()); await request })
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('invalidates older requests when a session check observes another user', async () => {
    const alice: auth.User = { ...admin, id: 2, username: 'alice', displayName: 'Alice', role: 'user' }
    jest.mocked(auth.readServerSession).mockResolvedValueOnce(admin).mockResolvedValue(alice)
    const response = deferred<Response>()
    global.fetch = jest.fn<typeof fetch>().mockReturnValue(response.promise)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    const request = auth.apiRequest('/logs').catch(error => error)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByText('Alice')).toBeInTheDocument()
    await act(async () => { response.resolve(unauthorized()); await request })
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
  })

  it('unmounts private component state and resources when a session check switches accounts', async () => {
    const cleanup = jest.fn()
    const alice: auth.User = { ...admin, id: 2, username: 'alice', displayName: 'Alice', role: 'user' }
    jest.mocked(auth.readServerSession).mockResolvedValueOnce(admin).mockResolvedValue(alice)
    function PrivateState () {
      const [value, setValue] = useState('')
      useEffect(() => () => { cleanup() }, [])
      return <input aria-label='Private state' value={value} onChange={event => setValue(event.target.value)} />
    }
    render(<I18nextProvider i18n={i18n}><AuthGate hash='/' doUpdateHash={jest.fn()}><PrivateState /></AuthGate></I18nextProvider>)
    fireEvent.change(await screen.findByLabelText('Private state'), { target: { value: 'previous account data' } })
    expect(screen.getByLabelText('Private state')).toHaveValue('previous account data')
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByLabelText('Private state')).toHaveValue('')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('does not let a late logout completion close a newer login', async () => {
    const logout = deferred<void>()
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    jest.mocked(auth.signOutOnServer).mockReturnValue(logout.promise)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    act(() => { window.dispatchEvent(new Event(auth.SESSION_EXPIRED_EVENT)) })
    await submitCredentials()
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
    await act(async () => { logout.resolve() })
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
    expect(screen.getByText('管理员')).toBeInTheDocument()
  })

  it('invalidates old requests at logout start and still handles new 401s after failed logout', async () => {
    jest.mocked(auth.readServerSession).mockResolvedValue(admin)
    jest.mocked(auth.signOutOnServer).mockRejectedValue(new Error('offline'))
    const response = deferred<Response>()
    global.fetch = jest.fn<typeof fetch>().mockReturnValue(response.promise)
    render(<Workspace />)
    await screen.findByText('Private workspace')
    const request = auth.apiRequest('/logs').catch(error => error)
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('alert')
    await act(async () => { response.resolve(unauthorized()); await request })
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
    jest.mocked(global.fetch).mockResolvedValue(unauthorized())
    await act(async () => { await auth.apiRequest('/logs').catch(() => {}) })
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })
})
