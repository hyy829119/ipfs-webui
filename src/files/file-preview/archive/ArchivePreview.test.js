import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import ArchivePreview from './ArchivePreview'
import { BrowserArchive } from './archive-client'
import { ArchiveError, archiveSupported } from './archive-utils'
import { readArchive } from './archive-source'

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: key => key }) }))
jest.mock('./archive-client')
jest.mock('./archive-source')
jest.mock('./archive-utils', () => ({ ...jest.requireActual('./archive-utils'), archiveSupported: jest.fn(), isSmallScreenDevice: () => false }))

const props = { name: 'files.zip', format: 'zip', size: 100, source: { url: '/ipfs/test', fallbackUrl: '/ipfs/test' }, read: jest.fn(), onSourceChange: jest.fn() }
let session, finish, reportProgress
beforeEach(() => {
  BrowserArchive.mockClear()
  archiveSupported.mockReturnValue(true)
  readArchive.mockResolvedValue(props.source)
  session = { init: jest.fn().mockResolvedValue(), unpack: jest.fn(() => new Promise(resolve => { finish = resolve })), close: jest.fn(), page: jest.fn().mockResolvedValue({ entries: [{ id: 0, path: 'folder/code.js', name: 'code.js', size: 30 }], count: 1 }) }
  BrowserArchive.mockImplementation(callback => { reportProgress = callback; return session })
})

it.each(['zip', 'rar', '7z', 'tar.gz', 'tar'])('extracts %s automatically and reveals downloads only after completion', async format => {
  const view = render(<ArchivePreview {...props} name='backup' format={format} />)
  await waitFor(() => expect(session.unpack).toHaveBeenCalledWith(format, ''))
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  act(() => reportProgress({ phase: 'extracting', loaded: 50, total: 100, completed: 0, count: 1 }))
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50')
  await act(async () => finish())
  expect(await screen.findByText('folder/code.js')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'archive.downloadEntry' })).toBeEnabled()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  view.unmount()
  expect(session.close).toHaveBeenCalled()
})

it('cancels the worker and never lists unfinished files', async () => {
  render(<ArchivePreview {...props} />)
  await waitFor(() => expect(session.unpack).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'app:actions.cancel' }))
  expect(session.close).toHaveBeenCalled()
  await act(async () => finish())
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.getByText('archive.cancelled')).toBeInTheDocument()
})

it('degrades before reading the archive if browser storage is unavailable', async () => {
  archiveSupported.mockReturnValue(false)
  readArchive.mockClear()
  render(<ArchivePreview {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('archive.errors.unsupported')
  expect(screen.getByText('archive.fallback')).toBeInTheDocument()
  expect(readArchive).not.toHaveBeenCalled()
})

it('aborts the ongoing read and closes the worker when the page is hidden', async () => {
  let signal
  readArchive.mockImplementation((_source, _read, _size, _smallScreen, _session, current) => {
    signal = current
    return new Promise((resolve, reject) => { current.addEventListener('abort', () => reject(new ArchiveError('cancelled'))) })
  })
  render(<ArchivePreview {...props} />)
  await waitFor(() => expect(signal).toBeDefined())
  await act(async () => window.dispatchEvent(new Event('pagehide')))
  expect(signal.aborted).toBe(true)
  expect(session.close).toHaveBeenCalled()
  expect(screen.getByText('archive.cancelled')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('cleans up a failed attempt before retrying with a password', async () => {
  session.unpack.mockRejectedValue(new ArchiveError('failed'))
  render(<ArchivePreview {...props} format='7z' />)
  expect(await screen.findByRole('alert')).toHaveTextContent('archive.errors.failed')
  expect(session.close).toHaveBeenCalled()
  session.unpack.mockResolvedValue()
  fireEvent.change(screen.getByLabelText('archive.password'), { target: { value: 'test-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'preview.retry' }))
  expect(await screen.findByText('folder/code.js')).toBeInTheDocument()
  expect(BrowserArchive).toHaveBeenCalledTimes(2)
  expect(session.unpack).toHaveBeenLastCalledWith('7z', 'test-password')
})

it('revokes replaced download URLs and the last URL when the preview closes', async () => {
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = jest.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
  URL.revokeObjectURL = jest.fn()
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    session.file = jest.fn().mockResolvedValue(new File(['code'], 'file-0'))
    const view = render(<ArchivePreview {...props} />)
    await waitFor(() => expect(session.unpack).toHaveBeenCalled())
    await act(async () => finish())
    const button = await screen.findByRole('button', { name: 'archive.downloadEntry' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('link', { name: 'archive.save' })).toHaveAttribute('href', 'blob:first'))
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('link', { name: 'archive.save' })).toHaveAttribute('href', 'blob:second'))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first')
    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(session.close).toHaveBeenCalled()
  } finally {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    click.mockRestore()
  }
})
