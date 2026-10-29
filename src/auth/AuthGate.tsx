import React, { createContext, useContext, useEffect, useState } from 'react'
import { connect } from 'redux-bundler-react'
import { useTranslation } from 'react-i18next'
import LoginPage, { LoginIcon } from './LoginPage'
import ComponentLoader from '../loader/ComponentLoader.js'
import { readServerSession, signInOnServer, signOutOnServer } from './server-auth'

export const SESSION_KEY = 'ifshare.session.v1'

// The standalone preview uses a local gate; Apache deployments validate a server session.
function readSession (): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === 'admin'
  } catch {
    return false
  }
}

interface Session {
  logout: () => Promise<void>
}

const SessionContext = createContext<Session | null>(null)

interface AuthGateProps {
  children: React.ReactNode
  hash: string
  doUpdateHash: (hash: string) => void
  serverAuth?: boolean
}

export function AuthGate ({ children, hash, doUpdateHash, serverAuth = process.env.REACT_APP_SERVER_AUTH === 'true' }: AuthGateProps) {
  const [authenticated, setAuthenticated] = useState(() => serverAuth ? false : readSession())
  const [checkingSession, setCheckingSession] = useState(serverAuth)

  useEffect(() => {
    if (!serverAuth) return
    let cancelled = false
    readServerSession().catch(() => false).then(valid => {
      if (!cancelled) {
        setAuthenticated(valid)
        setCheckingSession(false)
      }
    })
    return () => { cancelled = true }
  }, [serverAuth])

  useEffect(() => {
    if (checkingSession) return
    if (!authenticated && hash !== '/login') {
      doUpdateHash('/login')
    } else if (authenticated && hash === '/login') {
      doUpdateHash('/')
    }
  }, [authenticated, checkingSession, hash, doUpdateHash])

  const login = async (username: string, password: string): Promise<boolean> => {
    if (serverAuth) {
      if (!await signInOnServer(username, password)) return false
    } else if (process.env.REACT_APP_SERVER_AUTH !== 'true') {
      if (username.trim() !== 'admin' || password !== '123456') return false

      try {
        window.sessionStorage.setItem(SESSION_KEY, 'admin')
      } catch {
        // Keep the session in memory when browser storage is unavailable.
      }
    } else {
      return false
    }
    setAuthenticated(true)
    doUpdateHash('/')
    return true
  }

  const logout = async () => {
    if (serverAuth) await signOutOnServer()
    try {
      window.sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // The in-memory session is still cleared when storage is unavailable.
    }
    setAuthenticated(false)
    doUpdateHash('/login')
  }

  if (checkingSession) return <ComponentLoader />

  return (
    <SessionContext.Provider value={{ logout }}>
      {authenticated
        ? (hash === '/login' ? null : children)
        : <LoginPage onLogin={login} serverAuth={serverAuth} />}
    </SessionContext.Provider>
  )
}

export function AccountMenu () {
  const session = useContext(SessionContext)
  const { t } = useTranslation('login')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  if (session === null) return null

  const logout = async () => {
    setPending(true)
    setFailed(false)
    try {
      await session.logout()
    } catch {
      setFailed(true)
      setPending(false)
    }
  }

  return (
    <div className='ifshare-account'>
      <span className='ifshare-account-name'><LoginIcon name='user' />admin</span>
      {failed && <span role='alert'>{t('signOutFailed')}</span>}
      <button type='button' onClick={logout} disabled={pending} aria-label={t('signOut')} title={t('signOut')}>
        <LoginIcon name='logout' />
      </button>
    </div>
  )
}

export default connect('selectHash', 'doUpdateHash', AuthGate)
