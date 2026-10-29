const SESSION_URL = '/auth/session.json'

export async function readServerSession (): Promise<boolean> {
  const response = await fetch(SESSION_URL, { credentials: 'same-origin', cache: 'no-store' })
  if (response.status === 401 || response.status === 403) return false
  if (!response.ok) throw new Error('Session service unavailable')
  const session = await response.json()
  return session.authenticated === true
}

export async function signInOnServer (username: string, password: string): Promise<boolean> {
  const response = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ httpd_username: username.trim(), httpd_password: password }).toString()
  })
  if (response.status === 401 || response.status === 403) return false
  if (!response.ok) throw new Error('Login service unavailable')
  return readServerSession()
}

export async function signOutOnServer (): Promise<void> {
  const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok || await readServerSession()) throw new Error('Logout failed')
}
