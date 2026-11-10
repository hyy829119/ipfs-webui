/* global beforeEach, it, expect */
import { jest } from '@jest/globals'
import { composeBundlesRaw } from 'redux-bundler'
import createFilesBundle from './files/index.js'
import fileActions from './files/actions.js'
import { CID } from 'multiformats/cid'
import { recordFilesOperation } from '../logs/operation-log'

jest.mock('../logs/operation-log', () => ({ recordFilesOperation: jest.fn().mockResolvedValue(false) }))
beforeEach(() => recordFilesOperation.mockClear())

const iterate = async function * (items) {
  yield * items
}

function createMockIpfsBundle (ipfs) {
  return {
    name: 'ipfs',
    getExtraArgs: () => ({ getIpfs: () => ipfs }),
    selectIpfsConnected: () => true,
    selectIpfsReady: () => true
  }
}
const createMockIpfs = () => {
  return {
    addAll: jest.fn((files) => iterate(files.map((file) => ({
      path: file.path,
      cid: CID.parse('QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'),
      size: file.size
    })))),
    files: {
      cp: jest.fn()
    }
  }
}

function createStore (ipfs) {
  return composeBundlesRaw(
    createMockIpfsBundle(ipfs),
    {
      name: 'mockRoutesBundle',
      selectRouteInfo: () => ({
        url: ''
      })
    },
    createFilesBundle()
  )()
}

it('write single file to root', async () => {
  const ipfs = createMockIpfs()
  const store = createStore(ipfs)

  const input = [{
    path: 'test.txt',
    size: 400
  }]

  await store.doFilesWrite(input, '/')

  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
  expect(recordFilesOperation).toHaveBeenCalledWith('upload', input, '/')
  expect(ipfs.addAll.mock.calls.length).toBe(1)
  expect(ipfs.addAll.mock.calls[0][0][0]).toBe(input[0])
  expect(ipfs.files.cp.mock.calls.length).toBe(1)
  expect(ipfs.files.cp.mock.calls[0][0]).toBe('/ipfs/QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
  expect(ipfs.files.cp.mock.calls[0][1]).toBe('/test.txt')
})

it('write single file to directory', async () => {
  const ipfs = createMockIpfs()
  const store = createStore(ipfs)

  const input = [{
    path: 'test.txt',
    size: 400
  }]

  await store.doFilesWrite(input, '/dir')

  expect(ipfs.addAll.mock.calls.length).toBe(1)
  expect(ipfs.addAll.mock.calls[0][0][0]).toBe(input[0])
  expect(ipfs.files.cp.mock.calls.length).toBe(1)
  expect(ipfs.files.cp.mock.calls[0][0]).toBe('/ipfs/QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
  expect(ipfs.files.cp.mock.calls[0][1]).toBe('/dir/test.txt')
})

it('write multiple file', async () => {
  const ipfs = createMockIpfs()
  const store = createStore(ipfs)

  const input = [{
    path: 'wow.txt',
    size: 566
  },
  {
    path: 'test.txt',
    size: 400
  }]

  await store.doFilesWrite(input, '/')

  expect(ipfs.addAll.mock.calls.length).toBe(1)
  expect(ipfs.addAll.mock.calls[0][0][0]).toBe(input[0])
  expect(ipfs.addAll.mock.calls[0][0][1]).toBe(input[1])
  expect(ipfs.files.cp.mock.calls.length).toBe(2)
  expect(ipfs.files.cp.mock.calls[0][0]).toBe('/ipfs/QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
  expect(ipfs.files.cp.mock.calls[0][1]).toBe('/wow.txt')
  expect(ipfs.files.cp.mock.calls[1][0]).toBe('/ipfs/QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
  expect(ipfs.files.cp.mock.calls[1][1]).toBe('/test.txt')
})

it('write multiple file with ignored file', async () => {
  const ipfs = createMockIpfs()
  const store = createStore(ipfs)

  const input = [{
    path: 'wow.txt',
    size: 566
  },
  {
    path: '.DS_Store',
    size: 566
  },
  {
    path: 'test.txt',
    size: 400
  }]

  await store.doFilesWrite(input, '/')

  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
  expect(recordFilesOperation).toHaveBeenCalledWith('upload', [input[0], input[2]], '/')
  expect(ipfs.addAll.mock.calls.length).toBe(1)
  expect(ipfs.addAll.mock.calls[0][0][0]).toBe(input[0])
  expect(ipfs.addAll.mock.calls[0][0][1]).toBe(input[2])
  expect(ipfs.files.cp.mock.calls.length).toBe(2)
  expect(ipfs.files.cp.mock.calls[0][0]).toBe('/ipfs/QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
  expect(ipfs.files.cp.mock.calls[0][1]).toBe('/wow.txt')
  expect(ipfs.files.cp.mock.calls[1][0]).toBe('/ipfs/QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
  expect(ipfs.files.cp.mock.calls[1][1]).toBe('/test.txt')
})

it('records a CAR upload once before importing it, with the destination directory', async () => {
  const cid = CID.parse('QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
  const ipfs = {
    dag: { import: jest.fn(() => iterate([{ root: { cid } }])) },
    files: { stat: jest.fn().mockRejectedValue(new Error('Not found')), cp: jest.fn() }
  }
  const file = { path: 'backup.car', size: 10, content: { stream: jest.fn(() => iterate([])) } }
  const fetchFiles = jest.fn()
  await fileActions().doAddCarFile('/files/backups', file, 'imported')({
    getIpfs: () => ipfs,
    dispatch: jest.fn(),
    store: { selectFilesPathInfo: () => ({ isMfs: true }), doFilesFetch: fetchFiles }
  })
  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
  expect(recordFilesOperation).toHaveBeenCalledWith('upload', [file], '/backups')
  expect(recordFilesOperation.mock.invocationCallOrder[0]).toBeLessThan(ipfs.dag.import.mock.invocationCallOrder[0])
  expect(ipfs.files.cp).toHaveBeenCalledWith(`/ipfs/${cid}`, '/backups/imported')
  expect(fetchFiles).toHaveBeenCalledTimes(1)
})

it.each(['files', 'car'])('records the attempted %s upload even when the RPC node is unavailable', async format => {
  const file = { path: 'backup.car', size: 10, content: {} }
  const task = format === 'files'
    ? fileActions().doFilesWrite([file], '/files/backups')
    : fileActions().doAddCarFile('/files/backups', file, 'backup')
  await expect(task({ getIpfs: () => null })).rejects.toThrow('IFShare node was not found')
  expect(recordFilesOperation).toHaveBeenCalledTimes(1)
  expect(recordFilesOperation).toHaveBeenCalledWith('upload', [file], '/backups')
})
