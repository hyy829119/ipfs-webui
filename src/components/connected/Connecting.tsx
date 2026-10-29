import React from 'react'
import { useTranslation } from 'react-i18next'
import './Connecting.css'

export default function Connecting () {
  const { t } = useTranslation('app')
  return (
    <div className='ifshare-connecting' role='status' aria-live='polite'>
      <span className='ifshare-connecting-spinner' aria-hidden='true' />
      <span>{t('status.connectingToIpfs')}</span>
    </div>
  )
}
