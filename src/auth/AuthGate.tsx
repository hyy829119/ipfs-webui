import React, { createContext, useContext, useEffect, useState } from 'react'
import { connect } from 'redux-bundler-react'
import { useTranslation } from 'react-i18next'
import LoginPage, { LoginIcon } from './LoginPage'

export const SESSION_KEY = 'ifshare.session.v1'

// This local UI gate does not replace authorization on the Kubo RPC server.
function readSession (): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === 'admin'
  } catch {
    return false
  }
}

interface Session {
  logout: () => void
}

const SessionContext = createContext<Session | null>(null)

interface AuthGateProps {
  children: React.ReactNode
  hash: string
  doUpdateHash: (hash: string) => void
}

export function AuthGate ({ children, hash, doUpdateHash }: AuthGateProps) {
  const [authenticated, setAuthenticated] = useState(readSession)

  useEffect(() => {
    if (!authenticated && hash !== '/login') {
      doUpdateHash('/login')
    } else if (authenticated && hash === '/login') {
      doUpdateHash('/')
    }
  }, [authenticated, hash, doUpdateHash])

  const login = (username: string, password: string): boolean => {
    if (username.trim() !== 'admin' || password !== '123456') return false

    try {
      window.sessionStorage.setItem(SESSION_KEY, 'admin')
    } catch {
      // Keep the session in memory when browser storage is unavailable.
    }
    setAuthenticated(true)
    doUpdateHash('/')
    return true
  }

  const logout = () => {
    try {
      window.sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // The in-memory session is still cleared when storage is unavailable.
    }
    setAuthenticated(false)
    doUpdateHash('/login')
  }

  return (
    <SessionContext.Provider value={{ logout }}>
      {authenticated
        ? (hash === '/login' ? null : children)
        : <LoginPage onLogin={login} />}
    </SessionContext.Provider>
  )
}

export function AccountMenu () {
  const session = useContext(SessionContext)
  const { t } = useTranslation('login')
  if (session === null) return null

  return (
    <div className='ifshare-account'>
      <span className='ifshare-account-name'><LoginIcon name='user' />admin</span>
      <button type='button' onClick={session.logout} aria-label={t('signOut')} title={t('signOut')}>
        <LoginIcon name='logout' />
      </button>
    </div>
  )
}

export default connect('selectHash', 'doUpdateHash', AuthGate)
