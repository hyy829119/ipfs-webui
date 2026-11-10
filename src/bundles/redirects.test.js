import { composeBundlesRaw } from 'redux-bundler'
import redirects from './redirects.js'

function redirectFor (hash, failed = true) {
  const store = composeBundlesRaw({
    name: 'offlineUserManagement',
    reducer: (state = {}) => state,
    selectHash: () => hash,
    selectIpfsInitFailed: () => failed
  }, redirects)()
  return store.reactToIpfsConnectionFail()
}

it.each(['/users', '/users/42', '/logs', '/settings', '/login', '/'])('keeps node-independent route %s available while the node is offline', hash => {
  expect(redirectFor(hash)).toBeUndefined()
})

it('still directs file browsing to connection setup when the node is unavailable', () => {
  expect(redirectFor('/files')).toEqual({ actionCreator: 'doUpdateHash', args: ['#/welcome'] })
  expect(redirectFor('/files', false)).toBeUndefined()
})
