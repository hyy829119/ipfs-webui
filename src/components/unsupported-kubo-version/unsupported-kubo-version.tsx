import React from 'react'
import { useTranslation } from 'react-i18next'
import Box from '../box/Box.js'
import { useIdentity } from '../../contexts/identity-context'

interface UnsupportedKuboVersionProps {
}

/**
 * TODO: support various features and accept translation keys for each feature instead of hardcoding them only for the logs screen.
 */
const UnsupportedKuboVersion: React.FC<UnsupportedKuboVersionProps> = () => {
  const { t } = useTranslation('diagnostics')
  const { identity, agentVersionObject } = useIdentity()

  if (agentVersionObject == null) {
    return <div className='pa4'>{t('dhtProvide.screen.loading')}</div>
  }

  return (
    <Box className='pa4 tc' style={{ width: '100%' }}>
      <div className='mb4'>
        <div className='f1 mb3'>⚠️</div>
        <h3 className='montserrat fw6 charcoal ma0 f4 mb3'>
          {t('logs.unsupported.title')}
        </h3>
        <p className='charcoal-muted f5 lh-copy mb4'>
          {t('logs.unsupported.description', { version: identity?.agentVersion })}
        </p>
        <div className='mb4'>
          <h4 className='montserrat fw6 charcoal ma0 f5 mb3'>
            {t('logs.unsupported.upgradeTitle')}
          </h4>
          <p className='charcoal-muted f6 lh-copy mb3'>
            {t('logs.unsupported.upgradeDescription')}
          </p>
        </div>
      </div>
    </Box>
  )
}

export default UnsupportedKuboVersion
