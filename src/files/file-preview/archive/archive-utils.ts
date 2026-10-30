export const MOBILE_ARCHIVE_BYTES = 100 * 1024 * 1024
export const PAGE_SIZE = 50

export class ArchiveError extends Error {
  constructor (public code: string) {
    super(code)
    this.name = 'ArchiveError'
  }
}

export function isSmallScreenDevice (): boolean {
  // Use the physical screen and input capability, not the desktop window size.
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches &&
    Math.min(window.screen.width, window.screen.height) > 0 &&
    Math.min(window.screen.width, window.screen.height) <= 820
}

export function archiveSupported (): boolean {
  return typeof Worker === 'function' && typeof WebAssembly === 'object' &&
    typeof WebAssembly.instantiate === 'function' && typeof URL === 'function' &&
    typeof URL.createObjectURL === 'function' && typeof AbortController === 'function' &&
    typeof navigator.storage?.getDirectory === 'function'
}

export interface ArchiveEntry { id: number, path: string, name: string, size: number }
export interface ArchivePage { entries: ArchiveEntry[], count: number }
export interface ArchiveProgress {
  phase: string
  loaded: number
  total: number
  file?: string
  completed?: number
  count?: number
}
