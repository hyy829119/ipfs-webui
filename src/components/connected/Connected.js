import React from 'react'
import { connect } from 'redux-bundler-react'
import { withTranslation } from 'react-i18next'

const pickColor = (ipfsReady, ipfsConnected) => {
  if (ipfsReady && ipfsConnected) return 'teal'
  if (ipfsReady) return 'red'
  return 'gray'
}

const pickTitleKey = (ipfsReady, ipfsConnected) => {
  if (ipfsReady && ipfsConnected) return 'app:status.connectedToIpfs'
  if (ipfsReady) return 'ipfsApiRequestFailed'
  return 'app:status.connectingToIpfs'
}

export const Connected = ({ t, className, ipfsReady, ipfsConnected, doSetIsNodeInfoOpen }) => {
  const title = t(pickTitleKey(ipfsReady, ipfsConnected))
  const fill = pickColor(ipfsReady, ipfsConnected)

  return (
    <a title={title} className={`connection-pill ${fill} ${className}`} href='#/status' onClick={() => doSetIsNodeInfoOpen(true)}>
      <span className='connection-dot' aria-hidden='true' />
      <span>{title}</span>
    </a>
  )
}

export default connect(
  'selectIpfsReady',
  'selectIpfsConnected',
  'doSetIsNodeInfoOpen',
  withTranslation('notify')(Connected)
)
