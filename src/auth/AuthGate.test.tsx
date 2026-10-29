import React, { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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

function Workspace ({ initialHash = '/files/private' }: { initialHash?: string }) {
  const [hash, setHash] = useState(initialHash)
  return (
    <I18nextProvider i18n={i18n}>
      <AuthGate hash={hash} doUpdateHash={setHash}>
        <h1>Private workspace</h1>
        <span data-testid='workspace-route'>{hash}</span>
        <AccountMenu />
      </AuthGate>
    </I18nextProvider>
  )
}

function submitCredentials (username = 'admin', password = '123456') {
  userEvent.type(screen.getByLabelText('Username', { exact: true }), username)
  userEvent.type(screen.getByLabelText('Password', { exact: true }), password)
  userEvent.click(screen.getByRole('button', { name: 'Enter workspace' }))
}

describe('workspace login', () => {
  it('keeps a direct workspace URL behind the login form without mounting its children', () => {
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

  it.each([['other', '123456'], ['admin', 'wrong-password'], ['admin', '123456 ']])('rejects incorrect credentials for %s', (username, password) => {
    render(<Workspace />)
    submitCredentials(username, password)
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect username or password')
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('logs in with the fixed credentials and opens the homepage', () => {
    render(<Workspace />)
    submitCredentials()
    expect(screen.getByRole('heading', { name: 'Private workspace' })).toBeInTheDocument()
    expect(screen.getByTestId('workspace-route')).toHaveTextContent(/^\/$/)
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('admin')
  })

  it('restores the current tab session after a reload', () => {
    const first = render(<Workspace />)
    submitCredentials()
    first.unmount()
    render(<Workspace initialHash='/files' />)
    expect(screen.getByRole('heading', { name: 'Private workspace' })).toBeInTheDocument()
    expect(screen.getByTestId('workspace-route')).toHaveTextContent('/files')
  })

  it('clears the session on logout and requires credentials on the next visit', () => {
    const first = render(<Workspace />)
    submitCredentials()
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull()
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument()
    first.unmount()
    render(<Workspace initialHash='/settings' />)
    expect(screen.getByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('keeps login and logout usable when session storage is unavailable', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled') })
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled') })
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage disabled') })
    render(<Workspace />)
    submitCredentials()
    expect(screen.getByRole('heading', { name: 'Private workspace' })).toBeInTheDocument()
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.getByRole('button', { name: 'Enter workspace' })).toBeInTheDocument()
  })

  it('can reveal the password without submitting or losing its value', () => {
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

  it('clears the error when credentials are edited and supports form submission', () => {
    render(<Workspace />)
    submitCredentials('admin', 'wrong')
    const password = screen.getByLabelText('Password', { exact: true })
    fireEvent.change(password, { target: { value: '123456' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.submit(password.closest('form') as HTMLFormElement)
    expect(screen.getByTestId('workspace-route')).toHaveTextContent(/^\/$/)
  })
})
