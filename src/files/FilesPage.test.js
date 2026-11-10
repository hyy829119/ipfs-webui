import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { FilesPage } from './FilesPage.js'
import { recordFilesOperation } from '../logs/operation-log'
import { advanceSessionGeneration } from '../auth/server-auth'
import Header from './header/Header.js'

jest.mock('../logs/operation-log', () => ({ recordFilesOperation: jest.fn() }))
jest.mock('ipld-explorer-components/providers', () => ({ useExplore: () => ({ doExploreUserProvidedPath: jest.fn() }) }), { virtual: true })
jest.mock('react-joyride', () => () => null)
jest.mock('react-helmet', () => ({ Helmet: () => null }))
jest.mock('../components/tour/withTour.js', () => component => component)
jest.mock('../lib/tours.js', () => ({ filesTour: { getSteps: () => [], styles: {} } }))
jest.mock('./info-boxes/InfoBoxes.js', () => () => null)
jest.mock('./sort-dropdown/SortDropdown.js', () => () => null)
jest.mock('./modals/Modals.js', () => () => null)
jest.mock('./file-import-status/FileImportStatus.js', () => () => null)
jest.mock('./files-grid/files-grid.js', () => () => null)
jest.mock('./selected-actions/SelectedActions.js', () => ({ download }) => <button onClick={download}>Download selection</button>)
jest.mock('./file-preview/FilePreview.js', () => ({ onDownload }) => <button onClick={onDownload}>Download preview</button>)
jest.mock('./header/Header.js', () => jest.fn(({ onAddFiles }) => <button onClick={() => onAddFiles([{ path: 'selected.txt', size: 1 }])}>Upload selected files</button>))
jest.mock('./files-list/FilesList.js', () => ({ files, onDownload, onSelect, onAddFiles, handleContextMenuClick }) => <>
  <button onClick={() => onDownload([files[0]])}>Download file</button>
  <button onClick={() => onSelect(files.map(file => file.name), true)}>Select all</button>
  <button onClick={event => handleContextMenuClick(event, 'RIGHT', files[0])}>Open menu</button>
  <button onClick={() => onAddFiles([{ path: '/dropped.txt', size: 1 }])}>Drop files</button>
</>)
jest.mock('./context-menu/ContextMenu.js', () => {
  const React = require('react')
  return React.forwardRef(({ isOpen, onDownloadCar }, ref) => <div ref={ref}>
    {isOpen && <button onClick={onDownloadCar}>Download CAR</button>}
  </div>)
})

const items = [
  { name: 'first.js', path: '/files/first.js', cid: 'first-cid', type: 'file', size: 1 },
  { name: 'second.txt', path: '/files/second.txt', cid: 'second-cid', type: 'file', size: 2 }
]
const props = {
  doFetchPinningServices: jest.fn(),
  doFilesFetch: jest.fn(),
  doPinsFetch: jest.fn(),
  doFilesSizeGet: jest.fn(),
  doFilesWrite: jest.fn(),
  doFilesDownloadLink: jest.fn(),
  doFilesDownloadCarLink: jest.fn(),
  files: { type: 'directory', path: '/files', content: items },
  filesPathInfo: { isMfs: true, path: '/files', realPath: '/', isRoot: true },
  t: key => key
}
beforeEach(() => {
  window.localStorage.clear()
  jest.clearAllMocks()
  window.location.hash = '#files'
  props.doFilesWrite.mockResolvedValue()
  props.doFilesDownloadLink.mockResolvedValue('#download')
  props.doFilesDownloadCarLink.mockResolvedValue('#car')
  // Even a stalled audit endpoint cannot delay download navigation.
  recordFilesOperation.mockImplementation(() => new Promise(() => {}))
})

it('records file-list and multi-selection downloads once per click', async () => {
  render(<FilesPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download file' }))
  await waitFor(() => expect(window.location.hash).toBe('#download'))
  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
  expect(recordFilesOperation).toHaveBeenLastCalledWith('download', [items[0]])
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
  fireEvent.click(screen.getByRole('button', { name: 'Download selection' }))
  expect(props.doFilesDownloadLink).toHaveBeenCalledTimes(2)
  expect(recordFilesOperation).toHaveBeenCalledTimes(2)
  expect(recordFilesOperation).toHaveBeenLastCalledWith('download', items.map(file => ({ ...file, pinned: false })))
})

it('records an explicit CAR download through the context menu', async () => {
  render(<FilesPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  fireEvent.click(screen.getByRole('button', { name: 'Download CAR' }))
  await waitFor(() => expect(window.location.hash).toBe('#car'))
  expect(props.doFilesDownloadCarLink).toHaveBeenCalledWith([items[0]])
  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
  expect(recordFilesOperation).toHaveBeenCalledWith('download', [items[0]])
})

it('records the preview download through the same user-action entry point', async () => {
  render(<FilesPage {...props} files={items[0]} />)
  expect(recordFilesOperation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Download preview' }))
  await waitFor(() => expect(props.doFilesDownloadLink).toHaveBeenCalledWith([items[0]]))
  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
  expect(recordFilesOperation).toHaveBeenCalledWith('download', [items[0]])
})

it('routes picker and dropped uploads to the shared logged write action without double reporting', () => {
  render(<FilesPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }))
  fireEvent.click(screen.getByRole('button', { name: 'Drop files' }))
  expect(props.doFilesWrite).toHaveBeenNthCalledWith(1, [{ path: 'selected.txt', size: 1 }], '/files')
  expect(props.doFilesWrite).toHaveBeenNthCalledWith(2, [{ path: '/dropped.txt', size: 1 }], '/files')
  expect(recordFilesOperation).not.toHaveBeenCalled()
})

it.each(['unmount', 'session change'])('does not navigate when a download link arrives after %s', async reason => {
  let finish
  props.doFilesDownloadLink.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<FilesPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download file' }))
  if (reason === 'unmount') view.unmount()
  else advanceSessionGeneration()
  await act(async () => { finish('#old-download') })
  expect(window.location.hash).toBe('#files')
  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
})

it('ignores a retained upload callback after the files workspace is closed', async () => {
  const view = render(<FilesPage {...props} />)
  const upload = Header.mock.calls[0][0].onAddFiles
  view.unmount()
  await upload([{ path: 'old-session.txt', size: 1 }])
  expect(props.doFilesWrite).not.toHaveBeenCalled()
})

it('settles file action failures already recorded by Redux without unhandled event rejections', async () => {
  props.doFilesWrite.mockRejectedValue(new Error('Upload failed'))
  props.doFilesDownloadLink.mockRejectedValue(new Error('Download failed'))
  props.doFilesDownloadCarLink.mockRejectedValue(new Error('CAR failed'))
  render(<FilesPage {...props} />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Upload selected files' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download file' }))
  })
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download CAR' })) })
  expect(window.location.hash).toBe('#files')
  expect(recordFilesOperation).toHaveBeenCalledTimes(2)
})
