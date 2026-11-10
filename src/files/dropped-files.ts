import { getSessionGeneration } from '../auth/server-auth'
import { normalizeFiles } from '../lib/files.js'
import type { ExtendedFile, FileStream } from './types'

// Native directory enumeration is asynchronous and can outlive the login that started it.
export async function addDroppedFiles (source: Promise<ExtendedFile[]>, onFiles: (files: FileStream[]) => unknown): Promise<void> {
  const generation = getSessionGeneration()
  try {
    const files = await source
    if (generation !== getSessionGeneration()) return
    await onFiles(normalizeFiles(files))
  } catch {
    console.warn('[IFShare] Dropped files could not be imported.')
  }
}
