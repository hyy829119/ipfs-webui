import { App } from './App.js'
import { advanceSessionGeneration } from './auth/server-auth'

jest.mock('react-dnd', () => ({ DropTarget: () => component => component }))
jest.mock('react-joyride', () => () => null)
jest.mock('./navigation/NavBar.js', () => () => null)
jest.mock('./components/notify/Notify.js', () => () => null)
jest.mock('./components/connected/Connected.js', () => () => null)
jest.mock('./components/tour/TourHelper.js', () => () => null)
jest.mock('./files/explore-form/files-explore-form.tsx', () => () => null)
jest.mock('./auth/AuthGate', () => ({ AccountMenu: () => null }))

function app () {
  const props = {
    doSetupLocalStorage: jest.fn(),
    doTryInitIpfs: jest.fn(),
    doFilesWrite: jest.fn().mockResolvedValue(),
    doUpdateHash: jest.fn(),
    routeInfo: { pattern: '/', params: {} }
  }
  const instance = new App(props)
  instance.componentDidMount()
  return { instance, props }
}

it('routes a global drop to the shared logged upload action once', async () => {
  const { instance, props } = app()
  const file = new File(['hello'], 'global.txt')
  await instance.addFiles(Promise.resolve([file]))
  expect(props.doFilesWrite).toHaveBeenCalledTimes(1)
  expect(props.doFilesWrite).toHaveBeenCalledWith([{ path: 'global.txt', content: file, size: 5 }], '/')
  expect(props.doUpdateHash).toHaveBeenCalledWith('/files')
  instance.componentWillUnmount()
})

it.each(['unmount', 'session change'])('discards a global directory drop that finishes after %s', async reason => {
  const { instance, props } = app()
  let finish
  const pending = instance.addFiles(new Promise(resolve => { finish = resolve }))
  if (reason === 'unmount') instance.componentWillUnmount()
  else advanceSessionGeneration()
  finish([new File([], 'old-session.txt')])
  await pending
  expect(props.doFilesWrite).not.toHaveBeenCalled()
  expect(props.doUpdateHash).not.toHaveBeenCalled()
  instance.componentWillUnmount()
})

it('settles a global upload failure handled by Redux', async () => {
  const { instance, props } = app()
  props.doFilesWrite.mockRejectedValue(new Error('RPC unavailable'))
  await expect(instance.addFiles(Promise.resolve([new File([], 'file.txt')]))).resolves.toBeUndefined()
  expect(props.doFilesWrite).toHaveBeenCalledTimes(1)
  instance.componentWillUnmount()
})
