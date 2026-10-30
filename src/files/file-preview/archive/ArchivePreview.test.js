import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import ArchivePreview from './ArchivePreview'
import { BrowserArchive } from './archive-client'
import { archiveSupported } from './archive-utils'
import { readArchive } from './archive-source'

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: key => key }) }))
jest.mock('./archive-client')
jest.mock('./archive-source')
jest.mock('./archive-utils', () => ({ ...jest.requireActual('./archive-utils'), archiveSupported: jest.fn(), isSmallScreenDevice: () => false }))

const props = { name: 'files.zip', size: 100, source: { url: '/ipfs/test', fallbackUrl: '/ipfs/test' }, read: jest.fn(), onSourceChange: jest.fn() }
let session, finish, reportProgress
beforeEach(() => {
  archiveSupported.mockReturnValue(true)
  readArchive.mockResolvedValue(props.source)
  session = { init: jest.fn().mockResolvedValue(), unpack: jest.fn(() => new Promise(resolve => { finish = resolve })), close: jest.fn(), page: jest.fn().mockResolvedValue({ entries: [{ id: 0, path: 'folder/code.js', name: 'code.js', size: 30 }], count: 1 }) }
  BrowserArchive.mockImplementation(callback => { reportProgress = callback; return session })
})

it('starts automatically, shows extraction progress, and reveals downloads only after completion', async () => {
  const view = render(<ArchivePreview {...props} />)
  await waitFor(() => expect(session.unpack).toHaveBeenCalledWith('zip', ''))
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
