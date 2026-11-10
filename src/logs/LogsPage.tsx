import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSession } from '../auth/AuthGate'
import { apiRequest } from '../auth/server-auth'
import { translateApiError } from '../auth/api-error'
import './LogsPage.css'

interface OperationLog {
  id: number
  username: string
  action: 'upload' | 'download' | 'preview'
  fileName: string
  filePath: string
  cid: string
  fileCount: number
  createdAt: string
}
interface LogPage { logs: OperationLog[], total: number, page: number, pageSize: number }
interface LogResponse { key: object, data?: LogPage, error?: unknown }

export default function LogsPage () {
  const { t, i18n } = useTranslation('logs')
  const { t: errors } = useTranslation('users')
  const { user } = useSession()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState({ page: 1, pageSize: 20, q: '', action: '' })
  const [response, setResponse] = useState<LogResponse | null>(null)
  const [revision, setRevision] = useState(0)
  const requestKey = useMemo(() => ({ query, revision, userId: user?.id, role: user?.role }), [query, revision, user?.id, user?.role])
  const loading = response?.key !== requestKey
  const error = loading ? null : response?.error
  // Old rows and totals must never be shown under another user or query scope.
  const result = (!loading && response?.data) || { logs: [], total: 0, page: 1, pageSize: query.pageSize }
  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ ...query, page: String(query.page), pageSize: String(query.pageSize) })
    apiRequest<LogPage>(`/logs?${params}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return
      const lastPage = Math.max(1, Math.ceil(data.total / query.pageSize))
      if (query.page > lastPage) setQuery(current => ({ ...current, page: lastPage }))
      else setResponse({ key: requestKey, data })
    }).catch(cause => {
      if (!controller.signal.aborted) setResponse({ key: requestKey, error: cause })
    })
    return () => controller.abort()
  }, [query, requestKey])
  const pages = Math.max(1, Math.ceil(result.total / query.pageSize))
  const date = (value: string) => {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(i18n.resolvedLanguage || i18n.language)
  }
  return (
    <section className='logs-page' dir={i18n.dir()} aria-labelledby='logs-heading'>
      <header className='logs-header'>
        <div><h2 id='logs-heading'>{t('title')}</h2><p>{t(user?.role === 'admin' ? 'scopeAll' : 'scopeOwn')}</p></div>
        <button type='button' onClick={() => setRevision(value => value + 1)} disabled={loading}>{t('refresh')}</button>
      </header>
      <form className='logs-filters' onSubmit={event => {
        event.preventDefault()
        setQuery(current => ({ ...current, q: search.trim(), page: 1 }))
      }}>
        <label className='logs-search'><span>{t('search')}</span><input type='search' value={search} maxLength={128} onChange={event => setSearch(event.target.value)} placeholder={t('searchPlaceholder')} /></label>
        <label><span id='logs-action-label'>{t('action')}</span><select aria-labelledby='logs-action-label' value={query.action} onChange={event => {
          const action = event.target.value
          setQuery(current => ({ ...current, action, page: 1 }))
        }}>
          <option value=''>{t('allActions')}</option>
          {(['upload', 'download', 'preview'] as const).map(action => <option key={action} value={action}>{t(`actions.${action}`)}</option>)}
        </select></label>
        <button type='submit' className='logs-primary'>{t('search')}</button>
      </form>
      <p className='logs-note'>{t('operationHint')}</p>
      {error != null && <p role='alert' className='logs-error'>{translateApiError(error, errors)}</p>}
      <div className='logs-results' aria-busy={loading}>
        {loading
          ? <p role='status' className='logs-empty'>{t('loading')}</p>
          : error != null
            ? null
            : result.logs.length === 0
              ? <p className='logs-empty'>{t('empty')}</p>
              : <table>
                <thead><tr><th scope='col'>{t('time')}</th><th scope='col'>{t('user')}</th><th scope='col'>{t('action')}</th><th scope='col'>{t('file')}</th><th scope='col'>{t('count')}</th></tr></thead>
                <tbody>{result.logs.map(log => <tr key={log.id}>
                  <td data-label={t('time')}><time dateTime={log.createdAt}>{date(log.createdAt)}</time></td>
                  <td data-label={t('user')}>{log.username}</td>
                  <td data-label={t('action')}><span className={`logs-action logs-action-${log.action}`}>{t(`actions.${log.action}`)}</span></td>
                  <td data-label={t('file')}><div className='logs-file'>
                    <strong>{log.fileName || t('unnamed')}</strong>
                    {log.filePath && <span>{log.filePath}</span>}
                    {log.cid && <code dir='ltr'>{log.cid}</code>}
                  </div></td>
                  <td data-label={t('count')}>{log.fileCount.toLocaleString(i18n.resolvedLanguage || i18n.language)}</td>
                </tr>)}</tbody>
              </table>}
      </div>
      <footer className='logs-pagination'>
        <span aria-live='polite'>{loading || error != null ? '—' : t('total', { count: result.total })}</span>
        <label><span id='logs-page-size-label'>{t('pageSize')}</span> <select aria-labelledby='logs-page-size-label' value={query.pageSize} onChange={event => {
          const pageSize = Number(event.target.value)
          setQuery(current => ({ ...current, pageSize, page: 1 }))
        }}>
          {[20, 50, 100].map(size => <option value={size} key={size}>{size}</option>)}
        </select></label>
        <div className='logs-page-controls'>
          <button type='button' disabled={loading || error != null || query.page <= 1} onClick={() => setQuery(current => ({ ...current, page: current.page - 1 }))}>{t('previous')}</button>
          <span>{loading || error != null ? '—' : t('page', { page: query.page, pages })}</span>
          <button type='button' disabled={loading || error != null || query.page >= pages} onClick={() => setQuery(current => ({ ...current, page: current.page + 1 }))}>{t('next')}</button>
        </div>
      </footer>
    </section>
  )
}
