import React from 'react'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Preview } from './FilePreview.js'
import { recordFileOperation } from '../../logs/operation-log'

jest.mock('../../logs/operation-log', () => ({ recordFileOperation: jest.fn().mockResolvedValue(true) }))
jest.mock('./TextPreview', () => ({ __esModule: true, default: ({ text }) => text }))
jest.mock('./archive/ArchivePreview', () => ({ __esModule: true, default: ({ format }) => <div data-testid='archive-preview'>{format}</div> }))

const cid = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'
const t = key => key
const read = async function * () { yield new TextEncoder().encode('<script>example</script>\nhello 中文') }
const props = { t, cid, size: 40, availableGatewayUrl: 'https://ifshare.example', read, onDownload: jest.fn(), onClose: jest.fn() }
const originalFetch = global.fetch
beforeEach(() => recordFileOperation.mockClear())
afterEach(() => { global.fetch = originalFetch })

it('renders text as inert content and keeps download available', async () => {
  const { container } = render(<Preview {...props} name='example.html' />)
  expect(await screen.findByText(/hello 中文/)).toBeInTheDocument()
  expect(screen.getByText('preview.connectedNode: ifshare.example')).toBeInTheDocument()
  expect(container.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'app:actions.download' }))
  expect(props.onDownload).toHaveBeenCalled()
})

it.each(['Program.cs', 'main.js', 'App.java', 'module.fs', 'notes.unknown', 'README'])('reads text from %s without an extension allowlist', async name => {
  render(<Preview {...props} name={name} />)
  expect(await screen.findByText(/hello 中文/)).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('offers download for binary content even with a code suffix', async () => {
  const binary = async function * () { yield Uint8Array.from([0, 255, 3, 1]) }
  render(<Preview {...props} name='binary.cs' read={binary} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('preview.binary')
  expect(screen.getByRole('button', { name: 'app:actions.download' })).toBeInTheDocument()
})

it('shows an empty file and a recoverable error instead of a permanent spinner', async () => {
  const empty = async function * () {}
  const view = render(<Preview {...props} name='empty.txt' size={0} read={empty} />)
  expect(await screen.findByText('preview.empty')).toBeInTheDocument()
  const failed = () => { throw new Error('Connection lost') }
  view.rerender(<Preview {...props} name='failed.txt' read={failed} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('preview.failed')
  expect(screen.getByRole('button', { name: 'preview.retry' })).toBeInTheDocument()
})

it('previews an image CID without a filename extension', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'image/png' }) })
  render(<Preview {...props} name={cid} />)
  expect(await screen.findByRole('img')).toHaveAttribute('src', expect.stringContaining('https://ifshare.example/ipfs/'))
})

it.each([['备份.RAR', 'rar'], ['备份.7z', '7z'], ['backup.zip', 'zip'], ['backup.tar.gz', 'tar.gz'], ['多文件.TAR', 'tar']])('opens %s directly in the archive view', async (name, format) => {
  const archiveRead = jest.fn()
  render(<Preview {...props} name={name} read={archiveRead} />)
  expect(await screen.findByTestId('archive-preview')).toHaveTextContent(format)
  expect(archiveRead).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('detects an IFShare multi-file TAR opened by CID across split reads', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/octet-stream' }) })
  const bytes = readFileSync('test/fixtures/archives/ifshare-multiple.tar')
  const archiveRead = async function * () { yield bytes.subarray(0, 256); yield bytes.subarray(256) }
  render(<Preview {...props} name={cid} size={bytes.length} read={archiveRead} />)
  expect(await screen.findByTestId('archive-preview')).toHaveTextContent('tar')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it.each([
  ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0]],
  ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 7, 1, 0]],
  ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['zip', [0x50, 0x4b, 3, 4]],
  ['tar.gz', [0x1f, 0x8b, 8]]
])('detects %s from a bare CID before attempting text decoding', async (format, signature) => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/octet-stream' }) })
  const bytes = Uint8Array.from([...signature, 0])
  const archiveRead = async function * () { yield bytes.subarray(0, 2); yield bytes.subarray(2) }
  render(<Preview {...props} name={cid} read={archiveRead} />)
  expect(await screen.findByTestId('archive-preview')).toHaveTextContent(format)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('detects a renamed RAR and retains the actual node after local reads fall back', async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': 'application/octet-stream' }) })
    .mockRejectedValueOnce(new Error('Local client stopped'))
  const archiveRead = async function * () { yield Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 1, 0]) }
  render(<Preview {...props} name='备份' read={archiveRead} previewLocalGatewayUrl='http://127.0.0.1:8080' />)
  expect(await screen.findByTestId('archive-preview')).toHaveTextContent('rar')
  expect(screen.getByText('preview.connectedNode: ifshare.example')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('falls back when a locally probed image fails to load', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'image/png' }) })
  render(<Preview {...props} name='photo.PNG' previewLocalGatewayUrl='http://127.0.0.1:8080' />)
  const img = await screen.findByRole('img')
  expect(img.src).toContain('127.0.0.1:8080')
  expect(screen.getByText('preview.local: 127.0.0.1:8080')).toBeInTheDocument()
  fireEvent.error(img)
  await waitFor(() => expect(screen.getByRole('img').src).toContain('ifshare.example'))
  expect(screen.getByText('preview.connectedNode: ifshare.example')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('updates the displayed node when a text read falls back from local to server', async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': 'text/plain' }) })
    .mockRejectedValueOnce(new Error('Local client stopped'))
  render(<Preview {...props} name='notes.txt' previewLocalGatewayUrl='http://127.0.0.1:8080' availableGatewayUrl='http://111.10.164.175:3000' />)
  expect(await screen.findByText(/hello 中文/)).toBeInTheDocument()
  expect(screen.getByText('preview.connectedNode: 111.10.164.175:3000')).toBeInTheDocument()
  expect(screen.queryByText(/preview.local:/)).not.toBeInTheDocument()
})

it('uses a streaming video URL with controls instead of buffering it via RPC', async () => {
  const videoRead = jest.fn()
  const { container } = render(<Preview {...props} name='movie.mp4' read={videoRead} />)
  await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('controls'))
  expect(container.querySelector('video')).toHaveAttribute('preload', 'metadata')
  expect(videoRead).not.toHaveBeenCalled()
})

it('records one preview per file even when renders, reads, or gateways change', async () => {
  const view = render(<React.StrictMode><Preview {...props} name='main.js' path='/files/main.js' /></React.StrictMode>)
  expect(await screen.findByText(/hello 中文/)).toBeInTheDocument()
  expect(recordFileOperation).toHaveBeenCalledTimes(1)
  expect(recordFileOperation).toHaveBeenLastCalledWith('preview', { fileName: 'main.js', filePath: '/files/main.js', cid })
  view.rerender(<React.StrictMode><Preview {...props} name='main.js' path='/files/main.js' availableGatewayUrl='https://another.example' read={async function * () { yield new TextEncoder().encode('updated') }} /></React.StrictMode>)
  expect(await screen.findByText('updated')).toBeInTheDocument()
  expect(recordFileOperation).toHaveBeenCalledTimes(1)
  view.rerender(<React.StrictMode><Preview {...props} name='next.js' path='/files/next.js' /></React.StrictMode>)
  expect(await screen.findByText(/hello 中文/)).toBeInTheDocument()
  expect(recordFileOperation).toHaveBeenCalledTimes(2)
})

it('records direct CID previews and explicit retries without counting gateway fallback', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('Unavailable'))
  render(<Preview {...props} name={cid} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('preview.failed')
  expect(recordFileOperation).toHaveBeenCalledTimes(1)
  expect(recordFileOperation).toHaveBeenLastCalledWith('preview', { fileName: cid, filePath: `/ipfs/${cid}`, cid })
  fireEvent.click(screen.getByRole('button', { name: 'preview.retry' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('preview.failed')
  expect(recordFileOperation).toHaveBeenCalledTimes(2)
})
