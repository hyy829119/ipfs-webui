import React from 'react'
import { withTranslation, Trans } from 'react-i18next'
import Box from '../box/Box.js'

/**
 * @param {Object} props
 * @param {import('i18next').TFunction} props.t
 */
export const AboutIpfs = ({ t }) => {
  return (
    <Box>
      <h2 className='mt0 mb3 montserrat fw2 f3 charcoal'>{t('aboutIpfs.header')}</h2>
      <ul className='pl3'>
        <Trans i18nKey='aboutIpfs.paragraph1' t={t}>
          <li className='mb2'><strong>A personal file workspace</strong> for storing, browsing, and organizing content on your own node</li>
        </Trans>
        <Trans i18nKey='aboutIpfs.paragraph2' t={t}>
          <li className='mb2'><strong>Peer-to-peer sharing</strong> that lets nodes exchange content directly using content addresses</li>
        </Trans>
        <Trans i18nKey='aboutIpfs.paragraph3' t={t}>
          <li className='mb2'><strong>Browser-based access</strong>: open content through an HTTP gateway or with <span>compatible applications</span></li>
        </Trans>
        <Trans i18nKey='aboutIpfs.paragraph4' t={t}>
          <li className='mb2'><strong>Content you control</strong>: import files, manage pins, and choose how to share your content</li>
        </Trans>
        <Trans i18nKey='aboutIpfs.paragraph5' t={t}>
          <li className='mb2'><strong>Node management in one place</strong>: review connection status, monitor bandwidth, and adjust <span>your node settings</span></li>
        </Trans>
      </ul>
    </Box>
  )
}

export default withTranslation('welcome')(AboutIpfs)
