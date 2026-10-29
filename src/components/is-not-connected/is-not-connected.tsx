import React, { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import classNames from 'classnames'
import ApiAddressForm from '../api-address-form/api-address-form'
import Box from '../box/Box.js'
import Shell from '../shell/Shell.js'
import GlyphAttention from '../../icons/GlyphAttention.js'
import { useBridgeSelector } from '../../helpers/context-bridge'
import { CLI_NAME } from '../../constants/branding.js'

const TABS = {
  UNIX: 'unix',
  POWERSHELL: 'windowsPS',
  WINDOWS: 'windowsCMD'
}

const IsNotConnected = () => {
  const { t } = useTranslation('welcome')
  const isSameOrigin = useBridgeSelector('selectIsSameOrigin')
  const [activeTab, setActiveTab] = useState(TABS.UNIX)
  const defaultDomains = ['http://localhost:3000', 'http://127.0.0.1:5001']
  const origin = window.location.origin
  const addOrigin = defaultDomains.indexOf(origin) === -1

  return (
    <Box className='pv3 ph4 lh-copy charcoal'>
      <div className='flex flex-wrap items-center'>
        <GlyphAttention style={{ height: 76 }} className='fill-red mr' role='presentation' />
        <h1 className='montserrat fw4 charcoal ma0 f3 red'>{t('app:status.couldNotConnect')}</h1>
      </div>
      <ol className='pl3 pt2'>
        <Trans i18nKey='notConnected.paragraph2' t={t}>
          <li className='mb3'>Is your IFShare node running? Try starting or restarting IFShare from your terminal:</li>
        </Trans>
        <Shell title='Any Shell'>
          <code className='db'><b className='no-select'>$ </b>{CLI_NAME} daemon</code>
          <code className='db'>Initializing daemon...</code>
          <code className='db'>RPC API server listening on /ip4/127.0.0.1/tcp/5001</code>
        </Shell>
        { !isSameOrigin && (
          <div>
            <Trans i18nKey='notConnected.paragraph3' t={t}>
              <li className='mb3 mt4'>Is your IFShare RPC API configured to allow <span>cross-origin (CORS) requests</span>? If not, run these commands and then start your daemon from the terminal:</li>
            </Trans>
            <div className='br1 overflow-hidden'>
              <div className='f7 mb0 sans-serif charcoal pv1 pl2 bg-black-20 flex items-center overflow-x-auto'>
                <button onClick={() => setActiveTab(TABS.UNIX)} className={classNames('pointer mr3 ttu tracked', activeTab === TABS.UNIX && 'fw7')}>
                Unix & MacOS
                </button>
                <button onClick={() => setActiveTab(TABS.POWERSHELL)} className={classNames('pointer mr3 ttu tracked', activeTab === TABS.POWERSHELL && 'fw7')}>
                  Windows Powershell
                </button>
                <button onClick={() => setActiveTab(TABS.WINDOWS)} className={classNames('pointer ttu tracked', activeTab === TABS.WINDOWS && 'fw7')}>
                  Windows CMD
                </button>
              </div>
              <div className='bg-black-70 snow pa2 f7 lh-copy monospace nowrap overflow-x-auto'>
                { activeTab === TABS.UNIX && (
                  <div>
                    <code className='db'><b className='no-select'>$ </b>{CLI_NAME} config --json API.HTTPHeaders.Access-Control-Allow-Origin '[{addOrigin && `"${origin}", `}"{defaultDomains.join('", "')}"]'</code>
                    <code className='db'><b className='no-select'>$ </b>{CLI_NAME} config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST"]'</code>
                  </div>
                )}
                { activeTab === TABS.POWERSHELL && (
                  <div>
                    <code className='db'><b className='no-select'>$ </b>{CLI_NAME} config --json API.HTTPHeaders.Access-Control-Allow-Origin '[{addOrigin && `\\"${origin}\\", `}\"{defaultDomains.join('\\", \\"')}\"]'</code>
                    <code className='db'><b className='no-select'>$ </b>{CLI_NAME} config --json API.HTTPHeaders.Access-Control-Allow-Methods '[\"PUT\", \"POST\"]'</code>
                  </div>
                )}
                { activeTab === TABS.WINDOWS && (
                  <div>
                    <code className='db'><b className='no-select'>$ </b>{CLI_NAME} config --json API.HTTPHeaders.Access-Control-Allow-Origin "[{addOrigin && `"""${origin}""", `}"""{defaultDomains.join('""", """')}"""]"</code>
                    <code className='db'><b className='no-select'>$ </b>{CLI_NAME} config --json API.HTTPHeaders.Access-Control-Allow-Methods "["""PUT""", """POST"""]"</code>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <Trans i18nKey='notConnected.paragraph4' t={t}>
          <li className='mt4 mb3'>Is your IFShare RPC on a port other than 5001? If your node is configured with a <span>custom RPC API address</span>, enter it here.</li>
        </Trans>
        <ApiAddressForm />
      </ol>
    </Box>
  )
}

export default IsNotConnected
