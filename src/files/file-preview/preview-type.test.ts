import { describe, expect, it } from '@jest/globals'
import { getPreviewType, getTextMode } from './preview-type'

describe('file preview classification', () => {
  it.each(['Program.cs', 'script.csx', 'main.js', 'App.java', 'main.fs', 'index.ts', 'settings.config', 'README', '.env.local', 'unknown.xyz'])('attempts text for %s', name => {
    expect(getPreviewType(name)).toBe('text')
  })

  it.each([
    ['Program.CS', 'csharp'], ['main.js', 'javascript'], ['App.java', 'java'],
    ['app.tsx', 'tsx'], ['main.py', 'python'], ['main.go', 'golang'],
    ['lib.rs', 'rust'], ['build.sh', 'sh'], ['project.csproj', 'xml'],
    ['settings.yaml', 'yaml'], ['settings.toml', 'toml'], ['.env.local', 'ini'],
    ['Dockerfile', 'dockerfile'], ['Makefile', 'makefile'], ['unknown.xyz', 'text']
  ])('selects syntax for %s without restricting text preview', (name, mode) => {
    expect(getTextMode(name)).toBe(mode)
  })

  it.each([['photo.PNG', 'image'], ['photo.avif', 'image'], ['clip.MP4', 'video'], ['clip.webm', 'video'], ['song.mp3', 'audio'], ['report.pdf', 'pdf']])('preserves the media renderer for %s', (name, type) => {
    expect(getPreviewType(name)).toBe(type)
  })

  it.each(['files.zip', 'files.RAR', '备份.7z', 'FILES.7Z', 'files.tar.gz', 'download.tar', '多文件.TAR'])('opens %s in the archive view', name => {
    expect(getPreviewType(name)).toBe('archive')
  })
})
