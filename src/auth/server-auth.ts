/* global RequestInit, JsonWebKey */
export interface User {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'user'
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
}

export const SESSION_EXPIRED_EVENT = 'ifshare:session-expired'
const API_ROOT = '/webui-api/v1'
let sessionGeneration = 0

export const getSessionGeneration = () => sessionGeneration
// Invalidate in-flight work when authentication starts changing or a new session is accepted.
export const advanceSessionGeneration = () => ++sessionGeneration

export class ApiError extends Error {
  constructor (message: string, public status: number, public code: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T> (path: string, init: RequestInit = {}): Promise<T> {
  const generation = getSessionGeneration()
  const headers = new Headers(init.headers)
  headers.set('X-IFShare-Request', '1')
  if (init.body) headers.set('Content-Type', 'application/json')
  const controller = new AbortController()
  const abort = () => controller.abort()
  init.signal?.addEventListener('abort', abort)
  if (init.signal?.aborted) abort()
  const timeout = window.setTimeout(abort, 15000)
  try {
    const response = await fetch(API_ROOT + path, {
      ...init, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      if (response.status === 401 && !path.startsWith('/auth/') && generation === getSessionGeneration()) {
        window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
      }
      throw new ApiError(body.error?.message || 'Request failed', response.status, body.error?.code || 'REQUEST_FAILED')
    }
    return response.status === 204 ? undefined as T : await response.json()
  } finally {
    window.clearTimeout(timeout)
    init.signal?.removeEventListener('abort', abort)
  }
}

export async function readServerSession (): Promise<User | null> {
  try {
    return (await apiRequest<{ user: User }>('/auth/session')).user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export async function signInOnServer (username: string, password: string): Promise<User | null> {
  if (!window.crypto?.subtle) {
    throw new ApiError('Secure browser cryptography is unavailable', 0, 'CRYPTO_UNAVAILABLE')
  }
  const name = username.trim()
  const encoder = new TextEncoder()
  const passwordBytes = encoder.encode(password)
  if (!passwordBytes.length || passwordBytes.length > 256) {
    throw new ApiError('Password must contain 1–256 UTF-8 bytes', 400, 'INVALID_PASSWORD_LENGTH')
  }
  const challenge = await apiRequest<{ challengeId: string, publicKey: JsonWebKey }>('/auth/challenge')
  const key = await window.crypto.subtle.importKey('jwk', challenge.publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
  // Bind the ciphertext to both this one-use challenge and the requested account.
  const encrypted = await window.crypto.subtle.encrypt({
    name: 'RSA-OAEP', label: encoder.encode(`${challenge.challengeId}:${name}`)
  }, key, passwordBytes)
  passwordBytes.fill(0)
  const ciphertext = btoa(String.fromCharCode(...new Uint8Array(encrypted)))
  try {
    const result = await apiRequest<{ user: User }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ username: name, challengeId: challenge.challengeId, password: ciphertext })
    })
    return result.user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export async function signOutOnServer (): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' })
}
