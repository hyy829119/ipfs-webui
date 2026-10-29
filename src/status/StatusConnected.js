import React from 'react'
import { withTranslation, Trans } from 'react-i18next'
import { connect } from 'redux-bundler-react'
import { humanSize } from '../lib/files.js'
import GlyphTick from '../icons/GlyphTick.js'

export const StatusConnected = ({ t, peersCount, repoSize }) => {
  const humanRepoSize = humanSize(repoSize || 0)
  return (
    <header className='status-summary'>
      <div className='status-summary-heading'>
        <span className='status-summary-mark'><GlyphTick width='28' height='28' className='fill-current-color' aria-hidden='true' /></span>
        <h2>
          <Trans i18nKey='app:status.connectedToIpfs' t={t}>Connected to IFShare</Trans>
        </h2>
      </div>
      <div className='status-metrics'>
        <a className='status-metric' href='#/files' aria-label={t('StatusConnected.repoSize', { repoSize: humanRepoSize })}>
          <span className='status-metric-label'>{t('spaceUsed')}</span>
          <span className='status-metric-value'>{humanRepoSize}</span>
        </a>
        <a className='status-metric' href='#/peers' aria-label={t('StatusConnected.peersCount', { peersCount: String(peersCount ?? 0) })}>
          <span className='status-metric-label'>{t('peers:title')}</span>
          <span className='status-metric-value'>{peersCount ?? 0}</span>
        </a>
      </div>
    </header>
  )
}

export const TranslatedStatusConnected = withTranslation('status')(StatusConnected)

export default connect(
  'selectPeersCount',
  'selectRepoSize',
  TranslatedStatusConnected
)
