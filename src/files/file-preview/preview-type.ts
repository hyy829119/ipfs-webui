const languageExtensions: Record<string, string[]> = {
  javascript: ['js', 'mjs', 'cjs'],
  jsx: ['jsx'],
  typescript: ['ts', 'mts', 'cts'],
  tsx: ['tsx'],
  csharp: ['cs', 'csx'],
  java: ['java'],
  c_cpp: ['c', 'h', 'cc', 'hh', 'cpp', 'hpp', 'cxx', 'hxx', 'ino'],
  python: ['py', 'pyw', 'pyi'],
  golang: ['go'],
  rust: ['rs'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  dart: ['dart'],
  php: ['php', 'phtml'],
  ruby: ['rb', 'rake', 'gemspec'],
  scala: ['scala', 'sc'],
  lua: ['lua'],
  perl: ['pl', 'pm'],
  r: ['r', 'rmd'],
  sh: ['sh', 'bash', 'zsh'],
  powershell: ['ps1', 'psm1', 'psd1'],
  batchfile: ['bat', 'cmd'],
  sql: ['sql'],
  html: ['html', 'htm', 'xhtml', 'vue', 'svelte'],
  css: ['css'],
  scss: ['scss'],
  sass: ['sass'],
  less: ['less'],
  json: ['json', 'jsonl', 'jsonc', 'map', 'ipynb'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'xaml', 'csproj', 'fsproj', 'vbproj', 'resx', 'props', 'targets'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  ini: ['ini', 'properties', 'cfg', 'env'],
  markdown: ['md', 'markdown', 'mdown', 'mdx'],
  diff: ['diff', 'patch'],
  dockerfile: ['dockerfile', 'containerfile'],
  makefile: ['mk', 'makefile'],
  text: ['txt', 'text', 'log', 'csv', 'tsv', 'conf', 'config', 'lock', 'sln', 'fs', 'fsx', 'fsi', 'vb', 'rst', 'adoc', 'tex']
}

const textModes = new Map(Object.entries(languageExtensions).flatMap(([mode, extensions]) => extensions.map(extension => [extension, mode] as const)))
const filenameModes: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby'
}

export function getTextMode (name: string): string {
  const filename = name.split('/').pop()?.toLowerCase() || ''
  if (filenameModes[filename]) return filenameModes[filename]
  if (filename.startsWith('.env.')) return 'ini'
  return textModes.get(filename.split('.').pop() || '') || 'text'
}

// Suffixes select a renderer/highlighter, never a text allowlist. All other
// files are sampled and checked for binary content before the text view opens.
export function getPreviewType (name: string): string {
  if (getArchiveFormat(name)) return 'archive'
  const extension = name.split('.').pop()?.toLowerCase() || ''
  if (textModes.has(extension)) return 'text'
  if (['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'].includes(extension)) return 'image'
  if (['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'mpeg', 'mpg', '3gp', 'm2ts'].includes(extension)) return 'video'
  if (['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'oga', 'ogg', 'aiff'].includes(extension)) return 'audio'
  return extension === 'pdf' ? 'pdf' : 'text'
}

export type ArchiveFormat = 'zip' | 'rar' | '7z' | 'tar.gz' | 'tar'

export function getArchiveFormat (name: string): ArchiveFormat | null {
  const filename = name.split('/').pop()?.toLowerCase() || ''
  if (filename.endsWith('.tar.gz')) return 'tar.gz'
  if (filename.endsWith('.zip')) return 'zip'
  if (filename.endsWith('.rar')) return 'rar'
  if (filename.endsWith('.7z')) return '7z'
  if (filename.endsWith('.tar')) return 'tar'
  return null
}
