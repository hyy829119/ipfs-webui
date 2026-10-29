import React from 'react'
import AceEditor from 'react-ace'
import { getTextMode } from './preview-type'
import { useTranslation } from 'react-i18next'
import 'brace/theme/chrome.js'
import 'brace/mode/text.js'
import 'brace/mode/javascript.js'
import 'brace/mode/typescript.js'
import 'brace/mode/tsx.js'
import 'brace/mode/jsx.js'
import 'brace/mode/json.js'
import 'brace/mode/html.js'
import 'brace/mode/css.js'
import 'brace/mode/xml.js'
import 'brace/mode/yaml.js'
import 'brace/mode/markdown.js'
import 'brace/mode/python.js'
import 'brace/mode/golang.js'
import 'brace/mode/java.js'
import 'brace/mode/c_cpp.js'
import 'brace/mode/sh.js'
import 'brace/mode/sql.js'
import 'brace/mode/ruby.js'
import 'brace/mode/csharp.js'
import 'brace/mode/rust.js'
import 'brace/mode/kotlin.js'
import 'brace/mode/swift.js'
import 'brace/mode/dart.js'
import 'brace/mode/php.js'
import 'brace/mode/scala.js'
import 'brace/mode/lua.js'
import 'brace/mode/perl.js'
import 'brace/mode/r.js'
import 'brace/mode/powershell.js'
import 'brace/mode/batchfile.js'
import 'brace/mode/scss.js'
import 'brace/mode/sass.js'
import 'brace/mode/less.js'
import 'brace/mode/toml.js'
import 'brace/mode/ini.js'
import 'brace/mode/diff.js'
import 'brace/mode/dockerfile.js'
import 'brace/mode/makefile.js'

export default function TextPreview ({ name, text }: { name: string, text: string }) {
  const { t } = useTranslation('files')
  const mode = getTextMode(name)
  return (
    <div className='file-preview-editor'>
      <div className='file-preview-editor-toolbar'>
        <span>{mode === 'text' ? t('preview.text') : mode.toUpperCase()}</span>
        <span>{t('preview.wrap')}</span>
      </div>
      <AceEditor
        name='ifshare-file-preview'
        value={text}
        mode={mode}
        theme='chrome'
        readOnly
        wrapEnabled
        width='100%'
        height='min(65vh, 720px)'
        fontSize={14}
        showPrintMargin={false}
        showGutter
        highlightActiveLine={false}
        editorProps={{ $blockScrolling: Infinity }}
        setOptions={{ useWorker: false, showLineNumbers: true, tabSize: 2, highlightGutterLine: false }} />
    </div>
  )
}
