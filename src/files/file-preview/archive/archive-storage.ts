const lockName = (session: string) => `ifshare-archives/${session}`

export class ArchiveStorage {
  private readonly locks = typeof navigator.locks?.request === 'function' ? navigator.locks : null
  readonly session = `archive-${this.locks ? 'v2-' : ''}${Date.now()}-${Math.random().toString(36).slice(2)}`
  private releaseLock: () => void = () => {}
  private readonly released = new Promise<void>(resolve => { this.releaseLock = resolve })

  async prepare (): Promise<void> {
    if (!this.locks) return
    // The lock lives as long as this preview. Browser crashes release it too.
    await new Promise<void>((resolve, reject) => {
      void this.locks?.request(lockName(this.session), async () => {
        resolve()
        await this.released
      }).catch(reject)
    })
    await this.removeAbandoned()
  }

  private async parent () {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle('ifshare-archives')
  }

  private async removeAbandoned (): Promise<void> {
    try {
      const parent = await this.parent()
      if (!parent.entries || !this.locks) return
      for await (const [name, handle] of parent.entries()) {
        // Only v2 sessions participate in locking. Never delete older clients'
        // directories or another tab's active, possibly long-running job.
        if (handle.kind !== 'directory' || !/^archive-v2-\d+-[a-z0-9]+$/.test(name)) continue
        await this.locks.request(lockName(name), { ifAvailable: true }, async lock => {
          if (lock) await parent.removeEntry(name, { recursive: true })
        })
      }
    } catch {
      // Cleanup is best effort; init reports actual storage availability.
    }
  }

  async close (): Promise<void> {
    try {
      // Worker termination releases synchronous handles asynchronously.
      for (const delay of [0, 200, 1000]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay))
        try {
          const parent = await this.parent()
          await parent.removeEntry(this.session, { recursive: true })
          return
        } catch (error) {
          if (error instanceof DOMException && error.name === 'NotFoundError') return
        }
      }
      // A later preview can collect leftovers when the storage lock is gone.
    } finally {
      this.releaseLock()
    }
  }
}
