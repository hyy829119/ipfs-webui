import { composeBundlesRaw } from 'redux-bundler'
import connected from './connected.js'

const makeStore = (ready, failed, lastSuccess, lastError) => composeBundlesRaw({
  name: 'testConnection',
  selectIpfsReady: () => ready,
  selectIpfsInitFailed: () => failed,
  selectNodeBandwidthLastSuccess: () => lastSuccess,
  selectNodeBandwidthLastError: () => lastError
}, connected)()

it.each([
  [false, false, null, null, true, false],
  [true, false, null, null, true, false],
  [true, false, 100, null, false, true],
  [false, true, null, null, false, false],
  [true, false, null, 100, false, false],
  [true, false, 100, 200, false, false],
  [true, false, 300, 200, false, true]
])('separates initialization, first poll, failure and recovery (%s, %s, %s, %s)', (ready, failed, success, error, connecting, online) => {
  const store = makeStore(ready, failed, success, error)
  expect(store.selectIpfsConnecting()).toBe(connecting)
  expect(store.selectIpfsConnected()).toBe(online)
})
