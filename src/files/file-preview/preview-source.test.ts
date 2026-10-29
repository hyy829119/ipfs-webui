import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { resolvePreviewSource, readPreviewBytes, decodePreviewText, MAX_TEXT_PREVIEW, LOCAL_PREVIEW_TIMEOUT, type PreviewSource } from './preview-source'

const server = 'https://ifshare.example'
const local = 'http://127.0.0.1:8080'
const signal = () => new AbortController().signal
const originalFetch = global.fetch
const mockFetch = jest.fn<typeof fetch>()
const response = (status: number, mime = 'image/png') => ({ ok: status === 200, headers: new Headers({ 'Content-Type': mime }) } as Response)
const source: PreviewSource = { url: server + '/ipfs/cid', fallbackUrl: server + '/ipfs/cid', local: false, mime: '' }
const chunks = (parts: Uint8Array[]) => async function * () { yield * parts }

beforeEach(() => { global.fetch = mockFetch; mockFetch.mockReset() })
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers() })

describe('local preview selection', () => {
  it('uses a reachable local CID without sending credentials', async () => {
    mockFetch.mockResolvedValue(response(200))
    const result = await resolvePreviewSource(server, local, 'cid', '图片 #1.png', signal())
    expect(result.local).toBe(true)
    expect(result.url).toBe(local + '/ipfs/cid?filename=' + encodeURIComponent('图片 #1.png'))
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'HEAD', credentials: 'omit', referrerPolicy: 'no-referrer' })
  })

  it.each([404, 403, 500])('uses the server when local content returns %s', async status => {
    mockFetch.mockResolvedValue(response(status))
    const result = await resolvePreviewSource(server, local, 'cid', 'a.png', signal())
    expect(result.local).toBe(false)
    expect(result.url).toContain(server)
  })

  it('uses the server when the browser blocks loopback', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    expect((await resolvePreviewSource(server, local, 'cid', 'a.png', signal())).local).toBe(false)
  })

  it('aborts a hanging local probe and falls back within the deadline', async () => {
    jest.useFakeTimers()
    mockFetch.mockImplementation(async (_, options) => await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const pending = resolvePreviewSource(server, local, 'cid', 'a.mp4', signal())
    jest.advanceTimersByTime(LOCAL_PREVIEW_TIMEOUT)
    expect((await pending).local).toBe(false)
  })

  it('keeps the standalone gateway and does not probe unnecessarily', async () => {
    expect((await resolvePreviewSource(local, '', 'cid', 'a.png', signal())).url).toContain(local)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('avoids localhost subdomain redirects for embedded previews', async () => {
    expect((await resolvePreviewSource('http://localhost:8080/', '', 'cid', 'a.png', signal())).url).toBe(local + '/ipfs/cid?filename=a.png')
  })
})

describe('bounded text reads', () => {
  it('reads every chunk, including Chinese characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('hello 中文\n'.repeat(2000))
    const read = chunks([bytes.subarray(0, 7), bytes.subarray(7, 1024), bytes.subarray(1024)])
    const result = await readPreviewBytes(source, read, signal())
    expect(decodePreviewText(result.bytes, bytes.length).text).toBe('hello 中文\n'.repeat(2000))
  })

  it('limits a large file and stops its iterator', async () => {
    let closed = false
    const read = async function * () {
      try { yield new Uint8Array(MAX_TEXT_PREVIEW * 2).fill(97); throw new Error('over-read') } finally { closed = true }
    }
    const result = await readPreviewBytes(source, read, signal())
    expect(result.bytes.length).toBe(MAX_TEXT_PREVIEW + 1)
    expect(closed).toBe(true)
    expect(decodePreviewText(result.bytes, MAX_TEXT_PREVIEW * 2)).toEqual({ text: 'a'.repeat(MAX_TEXT_PREVIEW), truncated: true })
  })

  it('handles empty files and UTF-16 BOM text', () => {
    expect(decodePreviewText(new Uint8Array(), 0)).toEqual({ text: '', truncated: false })
    expect(decodePreviewText(Uint8Array.from([255, 254, 65, 0]), 4).text).toBe('A')
  })

  it('rejects binary data but preserves HTML as text', () => {
    expect(() => decodePreviewText(Uint8Array.from([0, 1, 2]), 3)).toThrow()
    const text = '<script>alert("example")</script>'
    expect(decodePreviewText(new TextEncoder().encode(text), text.length).text).toBe(text)
  })

  it('falls back to RPC if local content disappears after its probe', async () => {
    mockFetch.mockRejectedValue(new TypeError('Connection closed'))
    const result = await readPreviewBytes({ ...source, local: true, url: local }, chunks([new TextEncoder().encode('server text')]), signal())
    expect(result.local).toBe(false)
    expect(decodePreviewText(result.bytes, 11).text).toBe('server text')
  })
})
