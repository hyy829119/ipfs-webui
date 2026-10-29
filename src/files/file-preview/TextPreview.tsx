import React, { useState } from 'react'
import AceEditor from 'react-ace'
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

const modes: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonl: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  css: 'css',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  go: 'golang',
  java: 'java',
  c: 'c_cpp',
  cpp: 'c_cpp',
  h: 'c_cpp',
  hpp: 'c_cpp',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  sql: 'sql',
  rb: 'ruby'
}

export default function TextPreview ({ name, text }: { name: string, text: string }) {
  const { t } = useTranslation('files')
  const [wrap, setWrap] = useState(false)
  const mode = modes[name.split('.').pop()?.toLowerCase() || ''] || 'text'
  return (
    <div className='file-preview-editor'>
      <div className='file-preview-editor-toolbar'>
        <span>{mode === 'text' ? t('preview.text') : mode.toUpperCase()}</span>
        <label><input type='checkbox' checked={wrap} onChange={e => setWrap(e.target.checked)} /> {t('preview.wrap')}</label>
      </div>
      <AceEditor
        name='ifshare-file-preview'
        value={text}
        mode={mode}
        theme='chrome'
        readOnly
        wrapEnabled={wrap}
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
