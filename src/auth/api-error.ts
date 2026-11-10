import { TFunction } from 'i18next'
import { ApiError } from './server-auth'

// Translate stable error codes rather than exposing server-language messages.
// Keep the error itself in component state so it updates on language changes.
export function translateApiError (error: unknown, t: TFunction): string {
  const key = error instanceof ApiError ? 'errors.' + error.code : 'errors.NETWORK_ERROR'
  return t(key, { defaultValue: t('errors.REQUEST_FAILED') })
}
