import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Preview } from './FilePreview.js'

jest.mock('./TextPreview', () => ({ __esModule: true, default: ({ text }) => text }))

const cid = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'
const t = key => key
const read = async function * () { yield new TextEncoder().encode('<script>example</script>\nhello 中文') }
const props = { t, cid, size: 40, availableGatewayUrl: 'https://ifshare.example', read, onDownload: jest.fn(), onClose: jest.fn() }
const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch })

it('renders text as inert content and keeps download available', async () => {
  const { container } = render(<Preview {...props} name='example.html' />)
  expect(await screen.findByText(/hello 中文/)).toBeInTheDocument()
  expect(container.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'app:actions.download' }))
  expect(props.onDownload).toHaveBeenCalled()
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

it('falls back when a locally probed image fails to load', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'image/png' }) })
  render(<Preview {...props} name='photo.PNG' previewLocalGatewayUrl='http://127.0.0.1:8080' />)
  const img = await screen.findByRole('img')
  expect(img.src).toContain('127.0.0.1:8080')
  fireEvent.error(img)
  await waitFor(() => expect(screen.getByRole('img').src).toContain('ifshare.example'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('uses a streaming video URL with controls instead of buffering it via RPC', async () => {
  const videoRead = jest.fn()
  const { container } = render(<Preview {...props} name='movie.mp4' read={videoRead} />)
  await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('controls'))
  expect(container.querySelector('video')).toHaveAttribute('preload', 'metadata')
  expect(videoRead).not.toHaveBeenCalled()
})
