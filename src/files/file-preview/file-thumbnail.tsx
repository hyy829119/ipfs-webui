import { CID } from 'multiformats/cid'
import React, { useState, useEffect, useCallback, type FC } from 'react'
import { connect } from 'redux-bundler-react'
import typeFromExt from '../type-from-ext/index.js'
import { resolvePreviewSource, type PreviewSource } from './preview-source'
import './file-thumbnail.css'

export interface FileThumbnailProps {
  name: string
  cid: CID
  textPreview: string | null
  onLoad: () => void
}

interface FileThumbnailPropsConnected extends FileThumbnailProps {
  availableGatewayUrl: string
  previewLocalGatewayUrl: string
}

const FileThumbnail: FC<FileThumbnailPropsConnected> = ({ name, cid, availableGatewayUrl, previewLocalGatewayUrl, textPreview, onLoad }) => {
  const [error, setError] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [source, setSource] = useState<PreviewSource | null>(null)
  const type = typeFromExt(name)

  const handleImageError = useCallback(() => {
    if (source?.local && source.fallbackUrl) {
      setSource({ ...source, url: source.fallbackUrl, local: false })
      return
    }
    setError(true)
    setImageLoaded(false)
  }, [source])

  const handleImageLoad = useCallback(() => {
    setImageLoaded(true)
    onLoad?.()
  }, [onLoad])

  useEffect(() => {
    setImageLoaded(false)
    setError(false)
    setSource(null)
    const controller = new AbortController()
    if (type === 'image') {
      resolvePreviewSource(availableGatewayUrl, previewLocalGatewayUrl, String(cid), name, controller.signal).then(result => {
        if (!controller.signal.aborted) setSource(result)
      }).catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    }
    return () => controller.abort()
  }, [cid, name, type, availableGatewayUrl, previewLocalGatewayUrl])

  if (error || (!textPreview && !type.startsWith('image'))) {
    return null
  }

  // An image thumbnail loads from the gateway; without one there is nothing to
  // point the img at, so fall through to the text preview (or nothing).
  if (type === 'image' && source?.url) {
    return (
      <div className={`file-thumbnail ${!imageLoaded ? 'is-loading' : ''}`}>
        <div className="file-thumbnail-loading" />
        <img
          className="w-100 h-100 object-contain br2"
          alt={name}
          src={source.url}
          referrerPolicy='no-referrer'
          onError={handleImageError}
          onLoad={handleImageLoad}
          loading="lazy"
          decoding="async"
        />
      </div>
    )
  }

  if (textPreview) {
    return (
      <div className={`file-thumbnail file-thumbnail-text ${textPreview.length === 0 ? 'is-loading' : ''}`}>
        <div className="file-thumbnail-loading" />
        <pre className="file-thumbnail-content">
          {textPreview}
        </pre>
      </div>
    )
  }

  return null
}

export default connect(
  'selectAvailableGatewayUrl',
  'selectPreviewLocalGatewayUrl',
  FileThumbnail
) as FC<FileThumbnailProps>
