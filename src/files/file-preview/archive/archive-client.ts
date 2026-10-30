import { ArchiveError } from './archive-utils'
import type { ArchivePage, ArchiveProgress } from './archive-utils'

declare const __IFSHARE_ARCHIVE_WORKER_URL__: string

interface PendingRequest { resolve: (value: unknown) => void, reject: (error: ArchiveError) => void }

export class BrowserArchive {
  private worker: Worker
  private closed = false
  private sequence = 0
  private pending = new Map<number, PendingRequest>()
  private session = `archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
  private progress: (value: ArchiveProgress) => void

  constructor (progress: (value: ArchiveProgress) => void, worker = new Worker(new URL(__IFSHARE_ARCHIVE_WORKER_URL__, document.baseURI), { type: 'module', name: 'ifshare-archive' })) {
    this.worker = worker
    this.progress = progress
    worker.addEventListener('message', this.onMessage)
    worker.addEventListener('error', this.onWorkerError)
    worker.addEventListener('messageerror', this.onWorkerError)
  }

  private onMessage = ({ data }: MessageEvent): void => {
    if (data.progress) this.progress(data.progress)
    const task = this.pending.get(data.id)
    if (!task) return
    this.pending.delete(data.id)
    if (data.error) task.reject(new ArchiveError(data.error))
    else task.resolve(data.value)
  }

  private onWorkerError = (): void => { void this.close(new ArchiveError('unsupported')) }

  async close (reason = new ArchiveError('cancelled')): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const task of this.pending.values()) task.reject(reason)
    this.pending.clear()
    this.worker.removeEventListener('message', this.onMessage)
    this.worker.removeEventListener('error', this.onWorkerError)
    this.worker.removeEventListener('messageerror', this.onWorkerError)
    this.worker.terminate()
    // Worker termination releases synchronous handles. Remove only this view's temporary files.
    for (const delay of [0, 200, 1000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try {
        const root = await navigator.storage.getDirectory()
        const parent = await root.getDirectoryHandle('ifshare-archives')
        await parent.removeEntry(this.session, { recursive: true })
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return
      }
    }
  }

  private async request<T> (method: string, args: unknown, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.closed) throw new ArchiveError('cancelled')
    return await new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      try { this.worker.postMessage({ id, method, args }, transfer) } catch {
        this.pending.delete(id)
        reject(new ArchiveError('unsupported'))
      }
    })
  }

  async init (smallScreen: boolean): Promise<void> {
    // This guards loading the engine only; archive reading/extraction has no time limit.
    const timer = setTimeout(() => { void this.close(new ArchiveError('unsupported')) }, 45000)
    try { await this.request('init', { session: this.session, smallScreen }) } finally { clearTimeout(timer) }
  }

  async append (bytes: Uint8Array): Promise<void> { await this.request('append', { bytes }, [bytes.buffer]) }
  async reset (): Promise<void> { await this.request('reset', {}) }
  async unpack (format: string, password: string): Promise<void> { await this.request('unpack', { format, password }) }
  async page (query: string, page: number): Promise<ArchivePage> { return await this.request('page', { query, page }) }
  async file (id: number): Promise<File> { return await this.request('file', { id }) }
}
