import React, { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { AccountMenu, AuthGate, SESSION_KEY } from './AuthGate'
import translations from '../../public/locales/en/login.json'

const i18n = createInstance()

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { login: translations } }, interpolation: { escapeValue: false } })
})

beforeEach(() => window.sessionStorage.clear())
afterEach(() => { jest.restoreAllMocks() })

function Workspace ({ initialHash = '/files/private', serverAuth = false }: { initialHash?: string, serverAuth?: boolean }) {
  const [hash, setHash] = useState(initialHash)
  return (
    <I18nextProvider i18n={i18n}>
      <AuthGate hash={hash} doUpdateHash={setHash} serverAuth={serverAuth}>
        <h1>Private workspace</h1>
        <span data-testid='workspace-route'>{hash}</span>
        <AccountMenu />
      </AuthGate>
    </I18nextProvider>
  )
}

async function submitCredentials (username = 'admin', password = '123456') {
  userEvent.type(screen.getByLabelText('Username', { exact: true }), username)
  userEvent.type(screen.getByLabelText('Password', { exact: true }), password)
  await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Enter workspace' })) })
}

describe('workspace login', () => {
  it('keeps a direct workspace URL behind the login form without mounting its children', async () => {
    const mounted = jest.fn()
    const navigate = jest.fn()
    function PrivateContent () {
      mounted()
      return <h1>Private workspace</h1>
    }
    render(<I18nextProvider i18n={i18n}><AuthGate hash='/settings' doUpdateHash={navigate}><PrivateContent /></AuthGate></I18nextProvider>)
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(navigate).toHaveBeenCalledWith('/login')
    expect(mounted).not.toHaveBeenCalled()
  })

  it.each([['other', '123456'], ['admin', 'wrong-password'], ['admin', '123456 ']])('rejects incorrect credentials for %s', async (username, password) => {
    render(<Workspace />)
    await submitCredentials(username, password)
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect username or password')
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('logs in with the fixed credentials and opens the homepage', async () => {
    render(<Workspace />)
    await submitCredentials()
    expect(screen.getByRole('heading', { name: 'Private workspace' })).toBeInTheDocument()
    expect(screen.getByTestId('workspace-route')).toHaveTextContent(/^\/$/)
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('admin')
  })

  it('restores the current tab session after a reload', async () => {
    const first = render(<Workspace />)
    await submitCredentials()
    first.unmount()
    render(<Workspace initialHash='/files' />)
    expect(screen.getByRole('heading', { name: 'Private workspace' })).toBeInTheDocument()
    expect(screen.getByTestId('workspace-route')).toHaveTextContent('/files')
  })

  it('clears the session on logout and requires credentials on the next visit', async () => {
    const first = render(<Workspace />)
    await submitCredentials()
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Sign out' })) })
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull()
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
    first.unmount()
    render(<Workspace initialHash='/settings' />)
    expect(screen.getByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('keeps login and logout usable when session storage is unavailable', async () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled') })
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled') })
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage disabled') })
    render(<Workspace />)
    await submitCredentials()
    expect(screen.getByRole('heading', { name: 'Private workspace' })).toBeInTheDocument()
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Sign out' })) })
    expect(screen.getByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('can reveal the password without submitting or losing its value', async () => {
    render(<Workspace />)
    const password = screen.getByLabelText('Password', { exact: true })
    userEvent.type(password, '123456')
    userEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    expect(password).toHaveValue('123456')
    userEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
  })

  it('clears the error when credentials are edited and supports form submission', async () => {
    render(<Workspace />)
    await submitCredentials('admin', 'wrong')
    const password = screen.getByLabelText('Password', { exact: true })
    fireEvent.change(password, { target: { value: '123456' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => { fireEvent.submit(password.closest('form') as HTMLFormElement) })
    expect(screen.getByTestId('workspace-route')).toHaveTextContent(/^\/$/)
  })
})

describe('server authenticated workspace', () => {
  const originalFetch = global.fetch
  const mockFetch = jest.fn<typeof fetch>()
  const response = (status: number) => ({ ok: status === 200, status, json: async () => ({ authenticated: true }) } as Response)

  beforeEach(() => {
    global.fetch = mockFetch
    mockFetch.mockReset().mockResolvedValue(response(401))
  })
  afterEach(() => { global.fetch = originalFetch })

  it('does not trust a forged local session when the server rejects it', async () => {
    window.sessionStorage.setItem(SESSION_KEY, 'admin')
    render(<Workspace serverAuth />)
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
  })

  it('restores a valid server cookie without storing credentials in sessionStorage', async () => {
    mockFetch.mockResolvedValue(response(200))
    render(<Workspace serverAuth initialHash='/files' />)
    expect(await screen.findByText('Private workspace')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-route')).toHaveTextContent('/files')
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('keeps the workspace closed when the server rejects locally valid credentials', async () => {
    render(<Workspace serverAuth />)
    await screen.findByRole('button', { name: 'Enter workspace' })
    await submitCredentials()
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password')
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
  })

  it('logs in through the server and opens the homepage after checking the cookie', async () => {
    render(<Workspace serverAuth />)
    await screen.findByRole('button', { name: 'Enter workspace' })
    mockFetch.mockResolvedValue(response(200))
    await submitCredentials()
    expect(await screen.findByText('Private workspace')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-route')).toHaveTextContent(/^\/$/)
    expect(mockFetch).toHaveBeenCalledWith('/auth/login', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('shows a retryable error if the login service cannot be reached', async () => {
    render(<Workspace serverAuth />)
    await screen.findByRole('button', { name: 'Enter workspace' })
    mockFetch.mockRejectedValue(new Error('Network unavailable'))
    await submitCredentials()
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach the sign-in service')
    expect(screen.getByRole('button', { name: 'Enter workspace' })).toBeEnabled()
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
  })

  it('clears the server session before closing the workspace on logout', async () => {
    mockFetch.mockResolvedValueOnce(response(200))
    render(<Workspace serverAuth />)
    await screen.findByText('Private workspace')
    mockFetch.mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(401))
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Sign out' })) })
    expect(await screen.findByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('reports failed logout instead of claiming the server session was cleared', async () => {
    mockFetch.mockResolvedValue(response(200))
    render(<Workspace serverAuth />)
    await screen.findByText('Private workspace')
    mockFetch.mockRejectedValue(new Error('Network unavailable'))
    await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Sign out' })) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to sign out')
    expect(screen.getByText('Private workspace')).toBeInTheDocument()
  })
})
