import { createSelector } from 'redux-bundler'

const redirectsBundle = {
  name: 'redirects',

  reactToEmptyHash: createSelector(
    'selectHash',
    (hash) => {
      if (hash === '') {
        return { actionCreator: 'doUpdateHash', args: ['#/'] }
      }
    }
  ),

  reactToIpfsConnectionFail: createSelector(
    'selectIpfsInitFailed',
    'selectHash',
    (failed, hash) => {
      if (failed && !['/', '/login', '/welcome'].includes(hash) && !hash.startsWith('/status') && !hash.startsWith('/settings') && !hash.startsWith('/users') && !hash.startsWith('/logs')) {
        return { actionCreator: 'doUpdateHash', args: ['#/welcome'] }
      }
    }
  )
}
export default redirectsBundle
