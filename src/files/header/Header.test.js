import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Header } from './Header.js'

jest.mock('../breadcrumbs/Breadcrumbs.js', () => ({
  __esModule: true,
  default: ({ onClick }) => <button onClick={() => onClick({ path: '/files' })}>parent folder</button>
}))
jest.mock('../file-input/FileInput.js', () => ({ __esModule: true, default: () => <button>import</button> }))

const props = {
  t: key => key,
  files: { type: 'directory', path: '/files', cid: 'directory-cid' },
  filesPathInfo: { isMfs: true, isRoot: true },
  pins: [],
  pendingPins: [],
  failedPins: [],
  completedPins: [],
  filesSize: 1024,
  repoSize: 2048
}

it('keeps directory controls when browsing a folder', () => {
  render(<Header {...props}><button>sort files</button></Header>)
  expect(screen.getByRole('button', { name: 'sort files' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'import' })).toBeInTheDocument()
})

it('removes directory controls from previews while keeping navigation and file actions', () => {
  const onNavigate = jest.fn()
  const handleContextMenu = jest.fn()
  const files = { type: 'file', path: '/files/openclaw.svg', cid: 'file-cid' }
  render(<Header {...props} files={files} filesPathInfo={{ isMfs: true, isRoot: false }}
    onNavigate={onNavigate} handleContextMenu={handleContextMenu}>
    <button>sort files</button>
  </Header>)
  expect(screen.queryByRole('button', { name: 'sort files' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'import' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'parent folder' }))
  expect(onNavigate).toHaveBeenCalledWith({ path: '/files' })
  fireEvent.click(screen.getByRole('button', { name: 'app:actions.more' }))
  expect(handleContextMenu).toHaveBeenCalledWith(expect.anything(), 'TOP', { ...files, pinned: false }, expect.anything())
})
