import React, { useRef, useState } from 'react'
import { Helmet } from 'react-helmet'
import { useTranslation } from 'react-i18next'
import { APP_NAME } from '../constants/branding.js'
import './LoginPage.css'

type IconName = 'user' | 'lock' | 'arrow' | 'eye' | 'eyeOff' | 'logout' | 'content' | 'network' | 'storage'

export function LoginIcon ({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    user: <><circle cx='12' cy='8' r='3.5' /><path d='M5 21v-2a7 7 0 0 1 14 0v2' /></>,
    lock: <><rect x='5' y='10' width='14' height='11' rx='3' /><path d='M8 10V7a4 4 0 0 1 8 0v3M12 14v3' /></>,
    arrow: <path d='M4 12h16m-6-6 6 6-6 6' />,
    eye: <><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' /><circle cx='12' cy='12' r='3' /></>,
    eyeOff: <><path d='m3 3 18 18M10 5.2c.65-.13 1.32-.2 2-.2 6.5 0 10 7 10 7a20 20 0 0 1-3 3.8M6 6.3A22 22 0 0 0 2 12s3.5 7 10 7c2 0 3.8-.65 5.3-1.6M10 10a3 3 0 0 0 4 4' /></>,
    logout: <><path d='M10 4H5v16h5m5-12 4 4-4 4M9 12h10' /></>,
    content: <><path d='M9 3H5v4m10-4h4v4M5 17v4h4m10-4v4h-4M9 8l-1 8m8-8-1 8M6 11h12M6 14h12' /></>,
    network: <><circle cx='12' cy='5' r='3' /><circle cx='5' cy='18' r='3' /><circle cx='19' cy='18' r='3' /><path d='m10.5 7.5-4 8m7-8 4 8M8 18h8' /></>,
    storage: <><ellipse cx='12' cy='5' rx='8' ry='3' /><path d='M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7' /></>
  }

  return <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.65' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>{paths[name]}</svg>
}

const flowPaths = [
  'M90 82C155 82 165 145 280 145',
  'M280 145C368 145 366 65 465 65',
  'M85 232C172 232 173 145 280 145',
  'M280 145C360 145 377 237 468 237',
  'M280 145C280 105 290 74 280 28',
  'M280 145C280 190 280 218 280 271'
]

function DataFlow () {
  const { t } = useTranslation('login')
  return (
    <div className='login-network' aria-hidden='true'>
      <div className='login-network-grid' />
      <svg className='login-network-lines' viewBox='0 0 560 300'>
        <ellipse className='login-network-orbit' cx='280' cy='157' rx='201' ry='99' />
        <ellipse className='login-network-orbit' cx='280' cy='157' rx='144' ry='72' />
        {flowPaths.map((path, index) => (
          <g key={path}>
            <path className='login-network-track' d={path} />
            <path className='login-network-stream' d={path} style={{ animationDelay: (index * -0.8) + 's', animationDirection: index % 2 ? 'normal' : 'reverse' }} />
          </g>
        ))}
        <g className='login-network-terminal'><circle cx='280' cy='28' r='5' /><circle cx='280' cy='271' r='5' /></g>
        <g className='login-network-spark'><circle cx='183' cy='37' r='3' /><circle cx='383' cy='279' r='3' /><circle cx='514' cy='154' r='2' /><circle cx='42' cy='156' r='2' /></g>
      </svg>
      <div className='login-network-core'>
        <div className='login-network-core-halo' />
        <div className='login-network-core-mark'>IF<span /></div>
        <span className='login-network-core-name'>{APP_NAME}</span>
      </div>
      <div className='login-network-node login-network-node-one'><LoginIcon name='content' /><span>CID</span></div>
      <div className='login-network-node login-network-node-two'><LoginIcon name='network' /><span>P2P</span></div>
      <div className='login-network-node login-network-node-three'><LoginIcon name='storage' /><span>{t('diagram.content')}</span></div>
      <div className='login-network-node login-network-node-four'><LoginIcon name='storage' /><span>{t('diagram.node')}</span></div>
      <div className='login-network-caption'><span />{t('diagram.caption')}</div>
    </div>
  )
}

interface LoginPageProps {
  onLogin: (username: string, password: string) => boolean
}

export default function LoginPage ({ onLogin }: LoginPageProps) {
  const { t } = useTranslation('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(false)
  const passwordInput = useRef<HTMLInputElement>(null)

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onLogin(username, password)) {
      setError(true)
      passwordInput.current?.focus()
    }
  }

  return (
    <div className='ifshare-login'>
      <Helmet><title>{t('title') + ' | ' + APP_NAME}</title></Helmet>
      <header className='login-header'>
        <div className='login-brand'><span className='login-brand-mark'>IF</span><span>{APP_NAME}</span></div>
        <span className='login-header-label'>{t('headerLabel')}</span>
        <div className='login-header-tag'><LoginIcon name='network' /><span>POWERED BY {APP_NAME.toUpperCase()}</span></div>
      </header>

      <main className='login-main'>
        <section className='login-story' aria-labelledby='login-story-heading'>
          <div className='login-eyebrow'><span />{t('eyebrow')}</div>
          <h1 id='login-story-heading'>{t('headlineFirst')}<br /><em>{t('headlineSecond')}</em></h1>
          <p className='login-introduction'>{t('introduction')}</p>
          <DataFlow />
          <div className='login-features'>
            {(['content', 'network', 'storage'] as const).map(feature => (
              <article className='login-feature' key={feature}>
                <div className='login-feature-heading'><LoginIcon name={feature} /><h2>{t('features.' + feature + '.title')}</h2></div>
                <p>{t('features.' + feature + '.description')}</p>
              </article>
            ))}
          </div>
        </section>

        <section className='login-form-section' aria-labelledby='login-heading'>
          <div className='login-form-card'>
            <div className='login-form-emblem'><LoginIcon name='lock' /></div>
            <div className='login-form-eyebrow'>{t('workspace')}</div>
            <h2 id='login-heading'>{t('welcome')}</h2>
            <p className='login-form-description'>{t('description')}</p>
            <form onSubmit={submit} className='login-form'>
              <div className='login-field'>
                <label htmlFor='login-username'>{t('username')}</label>
                <div className={'login-input-wrap' + (error ? ' login-input-error' : '')}>
                  <LoginIcon name='user' />
                  <input id='login-username' name='username' autoComplete='username' autoCapitalize='none' spellCheck={false} required placeholder={t('usernamePlaceholder')} value={username} aria-invalid={error} aria-describedby={error ? 'login-error' : undefined} onChange={event => { setUsername(event.target.value); setError(false) }} />
                </div>
              </div>
              <div className='login-field'>
                <label htmlFor='login-password'>{t('password')}</label>
                <div className={'login-input-wrap' + (error ? ' login-input-error' : '')}>
                  <LoginIcon name='lock' />
                  <input ref={passwordInput} id='login-password' name='password' type={showPassword ? 'text' : 'password'} autoComplete='current-password' required placeholder={t('passwordPlaceholder')} value={password} aria-invalid={error} aria-describedby={error ? 'login-error' : undefined} onChange={event => { setPassword(event.target.value); setError(false) }} />
                  <button type='button' className='login-password-toggle' onClick={() => setShowPassword(!showPassword)} aria-label={t(showPassword ? 'hidePassword' : 'showPassword')} aria-pressed={showPassword}><LoginIcon name={showPassword ? 'eyeOff' : 'eye'} /></button>
                </div>
              </div>
              <div className='login-feedback'>
                {error ? <p id='login-error' role='alert'>{t('invalidCredentials')}</p> : <p>{t('sessionHint')}</p>}
              </div>
              <button type='submit' className='login-submit'><span>{t('signIn')}</span><LoginIcon name='arrow' /></button>
            </form>
            <div className='login-form-footer'><span />{t('formFooter')}<span /></div>
          </div>
          <p className='login-form-note'>{t('formNote')}</p>
        </section>
      </main>

      <footer className='login-footer'><span>{APP_NAME} · {t('footer')}</span><span>CONTENT ADDRESSED. PEER CONNECTED.</span></footer>
    </div>
  )
}
