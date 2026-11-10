import { ApiError, apiRequest } from '../auth/server-auth'

export type FileOperation = 'upload' | 'download' | 'preview'

interface FileOperationDetails {
  fileName?: string
  filePath?: string
  cid?: string | { toString: () => string }
  fileCount?: number
}

interface OperationFile {
  name?: string
  path?: string
  cid?: string | { toString: () => string }
}

let lastFailureWarning: number | undefined
const reportFailure = (cause: unknown, timedOut: boolean) => {
  const now = Date.now()
  if (lastFailureWarning !== undefined && now - lastFailureWarning < 30000) return
  lastFailureWarning = now
  // Fixed categories only: never print filenames, CIDs, users, or raw server errors.
  console.warn('[IFShare] File operation log could not be recorded.', {
    code: timedOut ? 'LOG_TIMEOUT' : cause instanceof ApiError ? 'LOG_HTTP_ERROR' : 'LOG_UNAVAILABLE',
    status: cause instanceof ApiError ? cause.status : 0
  })
}

const metadata = (value: string | undefined, maximum: number) => {
  // Keep metadata bounded without retaining file contents or control characters.
  const text = (value || '').replace(/\p{Cc}/gu, '').slice(0, maximum)
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text
}

const eventId = () => {
  if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
  const bytes = window.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Send at the start of a user action, while its current session is still active.
 * No queue or retry: a later login must never inherit another user's actions.
 */
export async function recordFileOperation (action: FileOperation, details: FileOperationDetails): Promise<boolean> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 3000)
  try {
    await apiRequest('/logs', {
      method: 'POST',
      keepalive: true,
      signal: controller.signal,
      body: JSON.stringify({
        eventId: eventId(),
        action,
        fileName: metadata(details.fileName, 256),
        filePath: metadata(details.filePath, 1024),
        cid: metadata(details.cid?.toString(), 256),
        fileCount: Math.min(1000000, Math.max(1, Math.trunc(details.fileCount || 1)))
      })
    })
    return true
  } catch (cause) {
    // Audit availability must not block uploading, reading, or downloading files.
    reportFailure(cause, controller.signal.aborted)
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

export function recordFilesOperation (action: FileOperation, files: OperationFile[], targetPath?: string): Promise<boolean> {
  if (!files.length) return Promise.resolve(false)
  const first = files[0]
  return recordFileOperation(action, {
    fileName: first.name || first.path?.split('/').pop(),
    filePath: targetPath ?? first.path,
    cid: first.cid,
    fileCount: files.length
  })
}
