// Minimal OPFS types for the project's TypeScript 4.1 DOM library.
interface ArchiveDirectoryHandle {
  entries?(): AsyncIterable<[string, { kind: string }]>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ArchiveDirectoryHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

interface StorageManager {
  getDirectory(): Promise<ArchiveDirectoryHandle>
}
