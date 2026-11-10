import React, { useEffect, useRef, useState } from 'react'
import { Modal } from 'react-overlays'
import { Trans, useTranslation } from 'react-i18next'
import { translateApiError } from '../auth/api-error'
import { useSession } from '../auth/AuthGate'
import { apiRequest, SESSION_EXPIRED_EVENT, User } from '../auth/server-auth'
import './UserManagement.css'

interface UserList {
  users: User[]
  total: number
  page: number
  pageSize: number
}

type UserAction = { kind: 'create' } | { kind: 'edit' | 'delete' | 'reset' | 'toggle', user: User }
interface UserDraft { username: string, displayName: string, enabled: boolean }

const pageSize = 20
const emptyDraft = (): UserDraft => ({ username: '', displayName: '', enabled: true })
function formatTime (time: string | null, locale: string, empty: string) {
  if (!time) return empty
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale, { hour12: false })
}

function UserDialog ({ action, pending, onClose, children }: { action: UserAction, pending: boolean, onClose: () => void, children: React.ReactNode }) {
  const { t, i18n } = useTranslation('users')
  return (
    <Modal
      show
      onHide={() => { if (!pending) onClose() }}
      renderBackdrop={props => <div {...props} className='users-modal-backdrop' />}
      renderDialog={props => (
        <div {...props} className='users-modal' dir={i18n.dir()} role='dialog' aria-modal='true' aria-labelledby='user-dialog-title' tabIndex={-1}>
          <div className='users-modal-heading'>
            <h2 id='user-dialog-title'>{t('dialogs.' + action.kind)}</h2>
            <button type='button' className='users-close' aria-label={t('dialogs.close')} disabled={pending} onClick={onClose}>×</button>
          </div>
          {children}
        </div>
      )}
    >
      <div />
    </Modal>
  )
}

function AdminUsers () {
  const { t, i18n } = useTranslation('users')
  const locale = i18n.resolvedLanguage || i18n.language
  const { user: currentUser } = useSession()
  const [list, setList] = useState<UserList>({ users: [], total: 0, page: 1, pageSize })
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const [action, setAction] = useState<UserAction | null>(null)
  const [draft, setDraft] = useState<UserDraft>(emptyDraft)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const mounted = useRef(true)
  const submitting = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    const parameters = new URLSearchParams({ q: query, page: String(page), pageSize: String(pageSize) })
    apiRequest<UserList>('/users?' + parameters.toString(), { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize))
      if (page > lastPage) {
        setPage(lastPage)
        return
      }
      setList(result)
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => { controller.abort() }
  }, [page, query, revision])

  const openAction = (next: UserAction) => {
    setActionError(null)
    setNotice('')
    setDraft(next.kind === 'create' ? emptyDraft() : { username: next.user.username, displayName: next.user.displayName, enabled: next.user.enabled })
    setAction(next)
  }

  const submitAction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!action || submitting.current) return
    submitting.current = true
    setPending(true)
    setActionError(null)
    try {
      let message = ''
      switch (action.kind) {
        case 'create':
          await apiRequest('/users', { method: 'POST', body: JSON.stringify({ ...draft, username: draft.username.trim(), displayName: draft.displayName.trim() }) })
          message = 'notices.created'
          break
        case 'edit':
          await apiRequest('/users/' + action.user.id, { method: 'PATCH', body: JSON.stringify({ ...draft, username: draft.username.trim(), displayName: draft.displayName.trim() }) })
          message = 'notices.updated'
          break
        case 'delete':
          await apiRequest('/users/' + action.user.id, { method: 'DELETE' })
          message = 'notices.deleted'
          break
        case 'reset':
          await apiRequest('/users/' + action.user.id + '/reset-password', { method: 'POST' })
          if (action.user.id === currentUser?.id) {
            window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
            return
          }
          message = 'notices.reset'
          break
        case 'toggle':
          await apiRequest('/users/' + action.user.id, { method: 'PATCH', body: JSON.stringify({ enabled: !action.user.enabled }) })
          message = action.user.enabled ? 'notices.disabled' : 'notices.enabled'
          break
      }
      if (mounted.current) {
        setAction(null)
        setNotice(message)
        setRevision(value => value + 1)
      }
    } catch (error) {
      if (mounted.current) setActionError(error)
    } finally {
      submitting.current = false
      if (mounted.current) setPending(false)
    }
  }

  const pages = Math.max(1, Math.ceil(list.total / pageSize))
  const isEditing = action?.kind === 'create' || action?.kind === 'edit'
  const isAdmin = action?.kind === 'edit' && action.user.role === 'admin'

  return (
    <section className='users-page' dir={i18n.dir()} aria-label={t('title')}>
      <div className='users-intro'>
        <div>
          <span className='users-eyebrow'>{t('eyebrow')}</span>
          <h2>{t('heading')}</h2>
          <p>{t('description')}</p>
        </div>
        <button type='button' className='users-button users-button-primary' onClick={() => openAction({ kind: 'create' })}><span aria-hidden='true'>＋</span> {t('addUser')}</button>
      </div>

      <div className='users-password-note'><Trans t={t} i18nKey='passwordNote' components={[<code dir='ltr' />]} /></div>
      {notice && <p className='users-notice' role='status'>{t(notice)}</p>}

      <div className='users-panel'>
        <div className='users-toolbar'>
          <form className='users-search' role='search' onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search.trim()); setRevision(value => value + 1) }}>
            <label className='users-sr-only' htmlFor='user-search'>{t('searchLabel')}</label>
            <input id='user-search' type='search' placeholder={t('searchLabel')} value={search} maxLength={64} onChange={event => setSearch(event.target.value)} />
            <button type='submit' className='users-button' disabled={loading}>{t('search')}</button>
          </form>
          <button type='button' className='users-button users-button-quiet' disabled={loading} onClick={() => setRevision(value => value + 1)}>{t(loading ? 'loading' : 'refresh')}</button>
        </div>

        {loadError !== null
          ? <div className='users-empty' role='alert'><p>{translateApiError(loadError, t)}</p><button type='button' className='users-button' onClick={() => setRevision(value => value + 1)}>{t('retry')}</button></div>
          : <div aria-busy={loading}>
            {loading && <p className='users-loading' role='status'>{t('loadingUsers')}</p>}
            {list.users.length > 0
              ? <table className='users-table'>
                <caption className='users-sr-only'>{t('listCaption')}</caption>
                <thead><tr><th scope='col'>{t('columns.user')}</th><th scope='col'>{t('columns.status')}</th><th scope='col'>{t('columns.createdAt')}</th><th scope='col'>{t('columns.lastLoginAt')}</th><th scope='col'>{t('columns.actions')}</th></tr></thead>
                <tbody>
                  {list.users.map(user => (
                    <tr key={user.id}>
                      <th scope='row'>
                        <div className='users-identity'><span className='users-avatar' aria-hidden='true'>{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span><span className='users-identity-text'><strong><bdi>{user.username}</bdi></strong><span dir='auto'>{user.displayName || t('noDisplayName')}</span></span></div>
                        <span className={'users-role' + (user.role === 'admin' ? ' users-role-admin' : '')}>{t('roles.' + user.role)}</span>
                      </th>
                      <td data-label={t('columns.status')}><span className={'users-status ' + (user.enabled ? 'users-status-enabled' : 'users-status-disabled')}><span />{t(user.enabled ? 'status.enabled' : 'status.disabled')}</span></td>
                      <td data-label={t('columns.createdAt')} className='users-date'>{formatTime(user.createdAt, locale, '—')}</td>
                      <td data-label={t('columns.lastLoginAt')} className='users-date'>{formatTime(user.lastLoginAt, locale, t('neverSignedIn'))}</td>
                      <td data-label={t('columns.actions')}>
                        <div className='users-row-actions'>
                          <button type='button' disabled={loading} onClick={() => openAction({ kind: 'edit', user })} aria-label={t('actionLabels.edit', { username: user.username })}>{t('actions.edit')}</button>
                          <button type='button' disabled={loading} onClick={() => openAction({ kind: 'reset', user })} aria-label={t('actionLabels.reset', { username: user.username })}>{t('actions.reset')}</button>
                          {user.role !== 'admin' && <>
                            <button type='button' disabled={loading} onClick={() => openAction({ kind: 'toggle', user })} aria-label={t(user.enabled ? 'actionLabels.disable' : 'actionLabels.enable', { username: user.username })}>{t(user.enabled ? 'actions.disable' : 'actions.enable')}</button>
                            <button type='button' className='users-danger-text' disabled={loading} onClick={() => openAction({ kind: 'delete', user })} aria-label={t('actionLabels.delete', { username: user.username })}>{t('actions.delete')}</button>
                          </>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              : !loading && <div className='users-empty'><p>{t(query ? 'noResults' : 'noUsers')}</p>{query && <button type='button' className='users-button' onClick={() => { setSearch(''); setQuery(''); setPage(1) }}>{t('clearSearch')}</button>}</div>}
          </div>}

        <div className='users-pagination'>
          <span>{t('totalUsers', { count: list.total })}</span>
          <div><button type='button' className='users-button' disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>{t('previous')}</button><span aria-live='polite'>{t('pagePosition', { page, pages })}</span><button type='button' className='users-button' disabled={loading || page >= pages} onClick={() => setPage(value => value + 1)}>{t('next')}</button></div>
        </div>
      </div>

      {action && <UserDialog action={action} pending={pending} onClose={() => setAction(null)}>
        <form onSubmit={submitAction}>
          {isEditing
            ? <div className='users-form-fields'>
              <label htmlFor='user-username'>{t('fields.username')}<input id='user-username' name='username' dir='ltr' autoComplete='off' spellCheck={false} autoCapitalize='none' required minLength={3} maxLength={32} pattern='[a-zA-Z0-9_.\-]{3,32}' title={t('fields.usernameHint')} disabled={pending || isAdmin} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} /></label>
              <p className='users-field-hint'>{t(isAdmin ? 'fields.adminUsernameHint' : 'fields.usernameHint')}</p>
              <label htmlFor='user-display-name'>{t('fields.displayName')}<input id='user-display-name' name='displayName' autoComplete='off' maxLength={64} disabled={pending} value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} placeholder={t('fields.displayNamePlaceholder')} /></label>
              <label className='users-checkbox' htmlFor='user-enabled'><input id='user-enabled' type='checkbox' checked={draft.enabled} disabled={pending || isAdmin} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{t('fields.enabled')}</label>
              {action.kind === 'create' && <p className='users-dialog-note'><Trans t={t} i18nKey='fields.initialPassword' components={[<code dir='ltr' />]} /></p>}
              {action.kind === 'edit' && action.user.enabled && !draft.enabled && <p className='users-dialog-note'>{t('fields.disableWarning')}</p>}
            </div>
            : <div className='users-confirmation'>
              <p>{t('confirmations.user')} <strong><bdi>{action.user.username}</bdi></strong></p>
              {action.kind === 'delete' && <p>{t('confirmations.delete')}</p>}
              {action.kind === 'reset' && <p><Trans t={t} i18nKey='confirmations.reset' components={[<code dir='ltr' />]} /></p>}
              {action.kind === 'toggle' && <p>{t(action.user.enabled ? 'confirmations.disable' : 'confirmations.enable')}</p>}
            </div>}
          {actionError !== null && <p className='users-error' role='alert'>{translateApiError(actionError, t)}</p>}
          <div className='users-dialog-actions'>
            <button type='button' className='users-button' disabled={pending} onClick={() => setAction(null)}>{t('cancel')}</button>
            <button type='submit' className={'users-button ' + (action.kind === 'delete' ? 'users-button-danger' : 'users-button-primary')} disabled={pending} aria-busy={pending}>{t(pending ? 'processing' : isEditing ? 'save' : 'confirm')}</button>
          </div>
        </form>
      </UserDialog>}
    </section>
  )
}

export default function UserManagement () {
  const { t, i18n } = useTranslation('users')
  const { user } = useSession()
  if (user?.role !== 'admin') {
    return <section className='users-page users-panel users-empty' dir={i18n.dir()}><h2>{t('accessDenied')}</h2><p>{t('adminOnly')}</p><a className='users-button users-button-primary' href='#/'>{t('backHome')}</a></section>
  }
  return <AdminUsers />
}
