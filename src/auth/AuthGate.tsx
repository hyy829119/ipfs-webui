import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { connect } from 'redux-bundler-react'
import { useTranslation } from 'react-i18next'
import LoginPage, { LoginIcon } from './LoginPage'
import ComponentLoader from '../loader/ComponentLoader.js'
import { advanceSessionGeneration, getSessionGeneration, readServerSession, signInOnServer, signOutOnServer, SESSION_EXPIRED_EVENT, User } from './server-auth'

interface Session {
  user: User | null
  logout: () => Promise<void>
}

const SessionContext = createContext<Session>({ user: null, logout: async () => {} })
export const useSession = () => useContext(SessionContext)

interface AuthGateProps {
  children: React.ReactNode
  hash: string
  doUpdateHash: (hash: string) => void
}

export function AuthGate ({ children, hash, doUpdateHash }: AuthGateProps) {
  const [user, setUser] = useState<User | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const currentUser = useRef<User | null>(null)
  const transition = useRef<number | null>(null)

  const acceptSession = useCallback((current: User | null, replace = false) => {
    if (replace || currentUser.current?.id !== current?.id) advanceSessionGeneration()
    currentUser.current = current
    setUser(current)
  }, [])

  useEffect(() => {
    let cancelled = false
    const generation = getSessionGeneration()
    readServerSession().catch(() => null).then(current => {
      if (!cancelled && generation === getSessionGeneration()) {
        acceptSession(current)
        setCheckingSession(false)
      }
    })
    return () => { cancelled = true }
  }, [acceptSession])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    const expire = () => { if (!cancelled) acceptSession(null) }
    const refresh = () => {
      if (document.visibilityState === 'hidden' || transition.current !== null) return
      const generation = getSessionGeneration()
      // A temporary network failure must not discard a valid session.
      readServerSession().then(current => {
        if (!cancelled && generation === getSessionGeneration()) acceptSession(current)
      }).catch(() => {})
    }
    const interval = window.setInterval(refresh, 30000)
    window.addEventListener(SESSION_EXPIRED_EVENT, expire)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire)
      window.removeEventListener('focus', refresh)
    }
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (checkingSession) return
    if (!user && hash !== '/login') doUpdateHash('/login')
    else if (user && hash === '/login') doUpdateHash('/')
  }, [user, checkingSession, hash, doUpdateHash])

  const login = async (username: string, password: string): Promise<boolean> => {
    const generation = advanceSessionGeneration()
    transition.current = generation
    try {
      const current = await signInOnServer(username, password)
      if (!current || generation !== getSessionGeneration()) return false
      acceptSession(current, true)
      doUpdateHash('/')
      return true
    } finally {
      if (transition.current === generation) transition.current = null
    }
  }

  const logout = async () => {
    const generation = advanceSessionGeneration()
    transition.current = generation
    try {
      await signOutOnServer()
      if (generation !== getSessionGeneration()) return
      acceptSession(null, true)
      doUpdateHash('/login')
    } finally {
      if (transition.current === generation) transition.current = null
    }
  }

  if (checkingSession) return <ComponentLoader />

  return (
    <SessionContext.Provider value={{ user, logout }}>
      {user ? (hash === '/login' ? null : <React.Fragment key={user.id}>{children}</React.Fragment>) : <LoginPage onLogin={login} />}
    </SessionContext.Provider>
  )
}

export function AccountMenu () {
  const session = useSession()
  const { t } = useTranslation('login')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!session.user) return null

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
      <span className='ifshare-account-name' title={session.user.username}><LoginIcon name='user' />{session.user.displayName || session.user.username}</span>
      {failed && <span role='alert'>{t('signOutFailed')}</span>}
      <button type='button' onClick={logout} disabled={pending} aria-label={t('signOut')} title={t('signOut')}>
        <LoginIcon name='logout' />
      </button>
    </div>
  )
}

export default connect('selectHash', 'doUpdateHash', AuthGate)
