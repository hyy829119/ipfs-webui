import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { humanSize } from '../../../lib/files.js'
import Button from '../../../components/button/button'
import { getArchiveFormat } from '../preview-type'
import type { PreviewRead, PreviewSource } from '../preview-source'
import { BrowserArchive } from './archive-client'
import { ArchiveError, archiveSupported, isSmallScreenDevice, PAGE_SIZE } from './archive-utils'
import type { ArchivePage, ArchiveProgress, ArchiveEntry } from './archive-utils'
import { readArchive } from './archive-source'
import './ArchivePreview.css'

interface Props {
  name: string
  size: number
  source: PreviewSource
  read: PreviewRead
  onSourceChange: (source: PreviewSource) => void
}

export default function ArchivePreview ({ name, size, source, read, onSourceChange }: Props) {
  const { t } = useTranslation('files')
  const [smallScreen] = useState(isSmallScreenDevice)
  const [status, setStatus] = useState('working')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<ArchiveProgress>({ phase: 'preparing', loaded: 0, total: 0 })
  const [listing, setListing] = useState<ArchivePage>({ entries: [], count: 0 })
  const [listingBusy, setListingBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [password, setPassword] = useState('')
  const [submittedPassword, setSubmittedPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [download, setDownload] = useState<{ name: string, url: string } | null>(null)
  const archive = useRef<BrowserArchive | null>(null)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!archiveSupported()) {
      setStatus('error')
      setError('unsupported')
      return
    }
    const current = new AbortController()
    const { signal } = current
    controller.current = current
    let session: BrowserArchive | null = null
    const dispose = () => { void session?.close() }
    signal.addEventListener('abort', dispose)
    window.addEventListener('pagehide', dispose)
    setStatus('working')
    setError('')
    setProgress({ phase: 'preparing', loaded: 0, total: 0 })
    setListing({ entries: [], count: 0 })
    setPage(0)
    setQuery('')
    setDownload(null)
    setSaving(false)
    const load = async () => {
      try {
        const format = getArchiveFormat(name)
        if (!format) throw new ArchiveError('invalid')
        session = new BrowserArchive(value => { if (!signal.aborted) setProgress(value) })
        archive.current = session
        await session.init(smallScreen)
        if (signal.aborted) return
        setProgress({ phase: 'loading', loaded: 0, total: size })
        const resolved = await readArchive(source, read, size, smallScreen, session, signal, loaded => {
          if (!signal.aborted) setProgress({ phase: 'loading', loaded, total: size })
        })
        if (signal.aborted) return
        onSourceChange(resolved)
        await session.unpack(format, submittedPassword)
        if (!signal.aborted) setStatus('ready')
      } catch (cause) {
        void session?.close()
        if (!signal.aborted) {
          setStatus('error')
          setError(cause instanceof ArchiveError ? cause.code : 'failed')
        }
      }
    }
    void load()
    return () => {
      current.abort()
      window.removeEventListener('pagehide', dispose)
      signal.removeEventListener('abort', dispose)
      if (archive.current === session) archive.current = null
    }
  }, [name, size, source, read, onSourceChange, attempt, submittedPassword, smallScreen])

  useEffect(() => {
    if (status !== 'ready' || !archive.current) return
    let active = true
    const session = archive.current
    setListingBusy(true)
    const timer = setTimeout(() => {
      session.page(query, page).then(result => {
        if (active) { setListing(result); setListingBusy(false) }
      }).catch(() => {
        if (active) { setError('failed'); setStatus('error'); void session.close() }
      })
    }, query ? 200 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [status, query, page])

  useEffect(() => {
    return () => { if (download) URL.revokeObjectURL(download.url) }
  }, [download])

  const cancel = () => {
    controller.current?.abort()
    setStatus('cancelled')
  }

  const save = async (entry: ArchiveEntry) => {
    const session = archive.current
    const signal = controller.current?.signal
    if (!session || !signal || saving) return
    setSaving(true)
    try {
      // File is backed by browser storage; creating its URL does not buffer its contents.
      const file = await session.file(entry.id)
      if (signal.aborted) return
      const url = URL.createObjectURL(file)
      setDownload({ name: entry.name, url })
      const link = document.createElement('a')
      link.href = url
      link.download = entry.name
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch {
      if (!signal.aborted) setError('download')
    } finally {
      if (!signal.aborted) setSaving(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(listing.count / PAGE_SIZE))
  const percent = progress.total > 0 ? Math.min(100, Math.round(progress.loaded / progress.total * 100)) : undefined
  const retry = (event: React.FormEvent) => {
    event.preventDefault()
    setSubmittedPassword(password)
    setAttempt(value => value + 1)
  }

  return <div className='archive-preview'>
    <div className='archive-intro'>
      <div><h3>{t('archive.title')}</h3><p>{t('archive.description')}</p></div>
      <span className='file-preview-badge'>{getArchiveFormat(name)?.toUpperCase()}</span>
    </div>
    <p className='archive-storage-note'>{t(smallScreen ? 'archive.mobileLimit' : 'archive.desktopStorage')}</p>
    {status === 'working' && <div className='archive-progress'>
      <div className='archive-progress-heading'>
        <span className='ifshare-connecting-spinner' aria-hidden='true' />
        <span role='status'>{t(`archive.${progress.phase}`)}</span>
        <Button type='link' minWidth={0} onClick={cancel}>{t('app:actions.cancel')}</Button>
      </div>
      <progress max={100} value={percent} aria-label={t(`archive.${progress.phase}`)} />
      <div className='archive-progress-detail'>
        <span>{progress.phase === 'scanning'
          ? t('archive.count', { count: progress.loaded })
          : `${humanSize(progress.loaded, {})}${progress.total > 0 ? ` / ${humanSize(progress.total, {})}` : ''}`}</span>
        <span>{percent === undefined ? '' : `${percent}%`}</span>
      </div>
      {progress.file && <div className='archive-current-file'>{progress.completed} / {progress.count} · {progress.file}</div>}
    </div>}
    {error && <div className='archive-notice' role='alert'>
      <p>{t(`archive.errors.${error}`)}</p><p>{t('archive.fallback')}</p>
    </div>}
    {status === 'cancelled' && <p className='archive-notice' role='status'>{t('archive.cancelled')}</p>}
    {download && <div className='archive-download-ready' role='status'>
      <span>{t('archive.ready')}: {download.name}</span>
      <a href={download.url} download={download.name}>{t('archive.save')}</a>
    </div>}
    {(status === 'error' || status === 'cancelled') && error !== 'unsupported' && <form className='archive-password' onSubmit={retry}>
      <label htmlFor='archive-password'>{t('archive.password')}</label>
      <input id='archive-password' className='input-reset' type='password' value={password}
        autoComplete='off' onChange={event => setPassword(event.target.value)} placeholder={t('archive.passwordHint')} />
      <Button type='link' minWidth={0} buttonType='submit'>{t('preview.retry')}</Button>
    </form>}
    {status === 'ready' && <>
      <p className='archive-complete' role='status'>{t('archive.complete')}</p>
      <div className='archive-list-toolbar'>
        <span>{t(listingBusy ? 'archive.searching' : 'archive.count', { count: listing.count })}</span>
        <input className='input-reset' type='search' aria-label={t('archive.search')} placeholder={t('archive.search')}
          value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
      </div>
      <ul className='archive-list' aria-label={t('archive.title')} aria-busy={listingBusy}>
        {listing.entries.map(entry => <li key={entry.id} className='archive-entry'>
          <div className='archive-entry-info'><span className='archive-entry-path'>{entry.path}</span>
            <span className='archive-entry-size'>{humanSize(entry.size, {})}</span>
          </div>
          <Button minWidth={0} disabled={saving || listingBusy} onClick={() => { void save(entry) }}
            aria-label={t('archive.downloadEntry', { name: entry.path })}>{t('app:actions.download')}</Button>
        </li>)}
      </ul>
      {!listingBusy && listing.count === 0 && <p className='archive-notice'>{t(query ? 'archive.noMatches' : 'archive.empty')}</p>}
      {pageCount > 1 && <div className='archive-pagination'>
        <Button type='link' minWidth={0} disabled={listingBusy || page === 0} onClick={() => setPage(value => value - 1)}>{t('archive.previous')}</Button>
        <span>{page + 1} / {pageCount}</span>
        <Button type='link' minWidth={0} disabled={listingBusy || page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>{t('archive.next')}</Button>
      </div>}
    </>}
  </div>
}
