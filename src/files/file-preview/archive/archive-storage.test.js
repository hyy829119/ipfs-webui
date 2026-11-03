import { ArchiveStorage } from './archive-storage'

let held, directories, parent, locks
const originalLocks = navigator.locks
const originalStorage = navigator.storage

beforeEach(() => {
  held = new Set()
  directories = new Set()
  parent = {
    entries: async function * () { for (const name of directories) yield [name, { kind: 'directory' }] },
    removeEntry: jest.fn(async name => { directories.delete(name) })
  }
  locks = {
    request: jest.fn(async (name, options, handler) => {
      if (typeof options === 'function') handler = options
      if (held.has(name)) {
        expect(options.ifAvailable).toBe(true)
        return await handler(null)
      }
      held.add(name)
      try { return await handler({ name }) } finally { held.delete(name) }
    })
  }
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ getDirectoryHandle: async () => parent }) } })
})

afterEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: originalStorage })
})

it('collects abandoned sessions while preserving other tabs and older clients', async () => {
  const active = new ArchiveStorage()
  await active.prepare()
  directories.add(active.session)
  const orphan = 'archive-v2-123-dead'
  directories.add(orphan)
  directories.add('archive-123-legacy')
  directories.add('unrelated')
  const current = new ArchiveStorage()
  await current.prepare()
  directories.add(current.session)
  expect(parent.removeEntry).toHaveBeenCalledTimes(1)
  expect(parent.removeEntry).toHaveBeenCalledWith(orphan, { recursive: true })
  expect(directories.has(active.session)).toBe(true)
  expect(held.has(`ifshare-archives/${active.session}`)).toBe(true)
  await current.close()
  expect(directories.has(active.session)).toBe(true)
  await active.close()
  await Promise.resolve()
  expect(held.size).toBe(0)
  expect([...directories]).toEqual(['archive-123-legacy', 'unrelated'])
})

it('does not sweep other sessions when Web Locks is unavailable', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
  directories.add('archive-v2-123-another')
  const current = new ArchiveStorage()
  await current.prepare()
  expect(current.session).not.toContain('v2-')
  expect(parent.removeEntry).not.toHaveBeenCalled()
  await current.close()
  expect(parent.removeEntry).toHaveBeenCalledTimes(1)
  expect(directories.has('archive-v2-123-another')).toBe(true)
})

it('still permits extraction when stale cleanup cannot access storage', async () => {
  parent.entries = async function * () { yield await Promise.reject(new DOMException('Unavailable', 'SecurityError')) }
  const current = new ArchiveStorage()
  await expect(current.prepare()).resolves.toBeUndefined()
  await current.close()
  await Promise.resolve()
  expect(held.size).toBe(0)
})
