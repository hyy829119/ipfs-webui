import React from 'react'
import { shallow } from 'enzyme'
import { StatusPage } from './StatusPage.js'
import Connecting from '../components/connected/Connecting'
import IsNotConnected from '../components/is-not-connected/is-not-connected.js'
import StatusConnected from './StatusConnected.js'
import { Connected } from '../components/connected/Connected.js'

const t = key => key

it('shows loading until the first connection result, never the failure page', () => {
  const page = shallow(<StatusPage t={t} ipfsConnecting ipfsConnected={false} />)
  expect(page.find(Connecting)).toHaveLength(1)
  expect(page.find(IsNotConnected)).toHaveLength(0)
  page.setProps({ ipfsConnecting: false, ipfsConnected: true })
  expect(page.find(StatusConnected)).toHaveLength(1)
  expect(page.find(IsNotConnected)).toHaveLength(0)
})

it('still shows genuine connection failures', () => {
  const page = shallow(<StatusPage t={t} ipfsConnecting={false} ipfsConnected={false} />)
  expect(page.find(IsNotConnected)).toHaveLength(1)
})

it('keeps the header neutral while connecting and red only after failure', () => {
  const pill = shallow(<Connected t={t} ipfsConnecting ipfsConnected={false} />)
  expect(pill.hasClass('red')).toBe(false)
  expect(pill.prop('title')).toBe('app:status.connectingToIpfs')
  pill.setProps({ ipfsConnecting: false })
  expect(pill.hasClass('red')).toBe(true)
})
