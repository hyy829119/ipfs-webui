import React, { useEffect, useState } from 'react'
import { connect } from 'redux-bundler-react'
import { withTranslation } from 'react-i18next'
import { CID } from 'multiformats/cid'
import typeFromExt from '../type-from-ext/index.js'
import { humanSize } from '../../lib/files.js'
import Button from '../../components/button/button.tsx'
import GlyphCancel from '../../icons/GlyphCancel.js'
import TextPreview from './TextPreview'
import { resolvePreviewSource, mediaType, readPreviewBytes, decodePreviewText, withPreviewTimeout } from './preview-source'
import './FilePreview.css'
import '../../components/connected/Connecting.css'

const isMedia = type => ['image', 'video', 'audio', 'pdf'].includes(type)
const isBareCid = name => {
  try { CID.parse(name); return true } catch { return false }
}

export const Preview = ({ t, name, cid, size, availableGatewayUrl, previewLocalGatewayUrl = '', read, onDownload, onClose }) => {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const key = `${cid}/${name}`

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    setResult(null)
    setError('')
    const load = async () => {
      try {
        const source = await resolvePreviewSource(availableGatewayUrl, previewLocalGatewayUrl, String(cid), name, signal)
        let type = typeFromExt(name)
        // A CID has no extension: use the gateway MIME type for media previews.
        if (isBareCid(name) && source.url) {
          let mime = source.mime
          if (!mime) {
            const response = await withPreviewTimeout(signal, async headSignal => await fetch(source.url, { method: 'HEAD', signal: headSignal, credentials: 'same-origin' }), 15000)
            if (!response.ok) throw new Error('Preview unavailable')
            mime = response.headers.get('Content-Type') || ''
          }
          type = mediaType(mime) || 'text'
        }
        if (isMedia(type)) {
          if (!source.url) throw new Error('Preview unavailable')
          if (!signal.aborted) setResult({ key, type, ...source })
          return
        }
        const { bytes, local } = await readPreviewBytes(source, read, signal)
        let decoded
        try {
          decoded = decodePreviewText(bytes, size)
        } catch {
          if (!signal.aborted) setError('unsupported')
          return
        }
        if (!signal.aborted) setResult({ key, type: 'text', ...source, local, ...decoded })
      } catch {
        if (!signal.aborted) setError('failed')
      }
    }
    load()
    return () => controller.abort()
  }, [key, name, cid, size, read, availableGatewayUrl, previewLocalGatewayUrl, attempt])

  const preview = result?.key === key ? result : null
  const onMediaError = () => {
    if (preview?.local && preview.fallbackUrl && preview.url !== preview.fallbackUrl) {
      setResult({ ...preview, url: preview.fallbackUrl, local: false })
    } else {
      setError('failed')
    }
  }

  return (
    <section className='file-preview'>
      <header className='file-preview-header'>
        <div className='file-preview-heading'>
          <h2 title={name}>{name}</h2>
          <div className='file-preview-meta'>
            <span>{humanSize(size)}</span>
            {preview && <span className='file-preview-badge'>{t(preview.local ? 'preview.local' : 'preview.connectedNode')}</span>}
          </div>
        </div>
        <div className='file-preview-actions'>
          <Button onClick={onDownload}>{t('app:actions.download')}</Button>
          {onClose && <button className='file-preview-close' onClick={onClose} aria-label={t('app:actions.close')}><GlyphCancel aria-hidden='true' /></button>}
        </div>
      </header>
      {error
        ? <div className='file-preview-message' role='alert'>
          <p>{t(error === 'unsupported' ? 'cantBePreviewed' : 'preview.failed')}</p>
          <p className='file-preview-hint'>{t('preview.downloadHint')}</p>
          {error === 'failed' && <Button onClick={() => setAttempt(value => value + 1)}>{t('preview.retry')}</Button>}
        </div>
        : !preview
            ? <div className='file-preview-message' role='status'><span className='ifshare-connecting-spinner' aria-hidden='true' /><p>{t('preview.loading')}</p></div>
            : <>
              {preview.type === 'image' && <div className='file-preview-media'><img key={preview.url} src={preview.url} alt={name} onError={onMediaError} referrerPolicy='no-referrer' /></div>}
              {preview.type === 'video' && <div className='file-preview-media'>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video key={preview.url} src={preview.url} controls preload='metadata' playsInline onError={onMediaError} />
              </div>}
              {preview.type === 'audio' && <div className='file-preview-media'>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio key={preview.url} src={preview.url} controls preload='metadata' onError={onMediaError} />
              </div>}
              {preview.type === 'pdf' && <object className='FilePreviewPDF w-100' data={preview.url} type='application/pdf' onError={onMediaError}><p>{t('noPDFSupport')}</p><Button onClick={onDownload}>{t('downloadPDF')}</Button></object>}
              {preview.type === 'text' && <>
                {preview.text.length === 0 ? <div className='file-preview-message'>{t('preview.empty')}</div> : <TextPreview name={name} text={preview.text} />}
                {preview.truncated && <p className='file-preview-limit'>{t('preview.limit')}</p>}
              </>}
            </>}
    </section>
  )
}

export default connect(
  'selectAvailableGatewayUrl',
  'selectPreviewLocalGatewayUrl',
  withTranslation('files')(Preview)
)
