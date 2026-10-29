import React from 'react'
import { connect } from 'redux-bundler-react'
import { withTranslation } from 'react-i18next'

const pickColor = (ipfsConnecting, ipfsConnected) => {
  if (ipfsConnecting) return 'gray'
  return ipfsConnected ? 'teal' : 'red'
}

const pickTitleKey = (ipfsConnecting, ipfsConnected) => {
  if (ipfsConnecting) return 'app:status.connectingToIpfs'
  return ipfsConnected ? 'app:status.connectedToIpfs' : 'ipfsApiRequestFailed'
}

export const Connected = ({ t, className, ipfsConnecting, ipfsConnected, doSetIsNodeInfoOpen }) => {
  const title = t(pickTitleKey(ipfsConnecting, ipfsConnected))
  const fill = pickColor(ipfsConnecting, ipfsConnected)

  return (
    <a title={title} className={`connection-pill ${fill} ${className}`} href='#/status' onClick={() => doSetIsNodeInfoOpen(true)}>
      <span className='connection-dot' aria-hidden='true' />
      <span>{title}</span>
    </a>
  )
}

export default connect(
  'selectIpfsConnecting',
  'selectIpfsConnected',
  'doSetIsNodeInfoOpen',
  withTranslation('notify')(Connected)
)
