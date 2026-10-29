import React from 'react'
import { connect } from 'redux-bundler-react'
import { withTranslation } from 'react-i18next'
import classnames from 'classnames'
import { APP_NAME } from '../constants/branding.js'
import StrokeMarketing from '../icons/StrokeMarketing.js'
import StrokeWeb from '../icons/StrokeWeb.js'
import StrokeCube from '../icons/StrokeCube.js'
import StrokeSettings from '../icons/StrokeSettings.js'
import StrokeIpld from '../icons/StrokeIpld.js'

// Styles
import './NavBar.css'

/**
 * @param {Object} props
 * @param {string} props.to
 * @param {React.ComponentType<React.SVGProps<SVGSVGElement>>} props.icon
 * @param {string} [props.alternative]
 * @param {boolean} [props.disabled]
 * @param {string} props.children
 */
const NavLink = ({
  to,
  icon,
  alternative,
  disabled,
  children
}) => {
  const Svg = icon
  const { hash } = window.location
  const href = `#${to}`
  const active = alternative
    ? hash === href || hash.startsWith(`${href}${alternative}`)
    : hash === href || hash.startsWith(`${href}/`)
  const anchorClass = classnames({
    'navbar-item-active': active,
    'navbar-item-disabled': disabled
  }, ['navbar-item'])

  return (
    // eslint-disable-next-line jsx-a11y/anchor-is-valid
    <a href={disabled ? undefined : href} onClick={(e) => e.currentTarget.blur()} className={anchorClass} aria-current={active ? 'page' : undefined} role='menuitem' title={children}>
      <Svg width='24' role='presentation' className='navbar-item-icon fill-current-color' />
      <span className='navbar-item-label'>{children}</span>
    </a>
  )
}

/**
 * @param {Object} props
 * @param {import('i18next').TFunction} props.t
 */
export const NavBar = ({ t }) => {
  const gitRevision = process.env.REACT_APP_GIT_REV
  return (
    <div className='navbar-inner'>
      <div className='flex flex-column'>
        <a href="#/welcome" className='navbar-brand' role='menuitem' title={t('welcome:description')}>
          <span className='navbar-monogram' aria-hidden='true'>IF</span>
          <span className='navbar-brand-name'>{APP_NAME}</span>
        </a>
        <div className='navbar-links' role='menubar' aria-label={APP_NAME}>
          <NavLink to='/' alternative="status" icon={StrokeMarketing}>{t('status:title')}</NavLink>
          <NavLink to='/files' icon={StrokeWeb}>{t('files:title')}</NavLink>
          <NavLink to='/explore' icon={StrokeIpld}>{t('explore:tabName')}</NavLink>
          <NavLink to='/peers' icon={StrokeCube}>{t('peers:title')}</NavLink>
          <NavLink to='/settings' icon={StrokeSettings}>{t('settings:title')}</NavLink>
        </div>
      </div>
      { gitRevision &&
        <div className='navbar-footer'>
          {t('app:terms.revision')} {gitRevision}
        </div>
      }
    </div>
  )
}

export default connect(
  withTranslation()(NavBar)
)
