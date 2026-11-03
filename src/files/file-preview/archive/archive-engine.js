export const MOBILE_BYTES = 100 * 1024 * 1024
export const MOBILE_ENTRIES = 10000
export const PAGE_SIZE = 50

export function archiveFailure (code) {
  return Object.assign(new Error(code), { code })
}

export function downloadName (path) {
  // eslint-disable-next-line no-control-regex
  const name = path.replace(/\\/g, '/').split('/').pop()?.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_') || 'file'
  return name === '.' || name === '..' ? 'file' : name
}

function hasTarHeader (bytes) {
  if (bytes.length < 512 || bytes[0] === 0) return false
  const field = Array.from(bytes.subarray(148, 156), byte => byte === 0 ? ' ' : String.fromCharCode(byte)).join('').trim()
  if (!/^[0-7]+$/.test(field)) return false
  const checksum = parseInt(field, 8)
  let unsigned = 0
  let signed = 0
  for (let index = 0; index < 512; index++) {
    const byte = index >= 148 && index < 156 ? 32 : bytes[index]
    unsigned += byte
    signed += byte < 128 ? byte : byte - 256
  }
  // A header checksum also recognizes older TAR variants without ustar magic.
  return checksum === unsigned || checksum === signed
}

// Share content detection between the preview and worker so CID-only files
// reach the same extractor as files with a recognized extension.
export function detectArchiveFormat (bytes) {
  const starts = signature => signature.every((byte, index) => bytes[index] === byte)
  if (starts([0x50, 0x4b, 3, 4]) || starts([0x50, 0x4b, 5, 6])) return 'zip'
  if (starts([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0]) || starts([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 1, 0])) return 'rar'
  if (starts([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z'
  // Gzip is only a TAR.GZ candidate; unpacking explicitly validates the inner TAR.
  if (starts([0x1f, 0x8b, 8])) return 'tar.gz'
  if (hasTarHeader(bytes)) return 'tar'
  return null
}

export function checkSignature (bytes, format) {
  // Empty TARs have two zero blocks. Only accept these with an explicit TAR
  // filename; otherwise ordinary zero-filled binary files would be misidentified.
  const emptyTar = format === 'tar' && bytes.length >= 1024 && bytes.subarray(0, 1024).every(byte => byte === 0)
  const valid = emptyTar || (format != null && detectArchiveFormat(bytes) === format)
  if (!valid) throw archiveFailure('invalid')
}

function command (engine, args, consume) {
  const stdout = engine.FS.getStream(1)
  const original = stdout.stream_ops
  stdout.stream_ops = {
    ...original,
    write: (_stream, buffer, offset, length) => {
      consume(buffer.subarray(offset, offset + length))
      return length
    }
  }
  try {
    const code = engine.callMain(args)
    if (code !== 0) throw archiveFailure('failed')
  } finally {
    stdout.stream_ops = original
  }
}

// Listing goes straight to a disk manifest, rather than building an unbounded array.
export function listArchive (engine, archivePath, password, onEntry, format) {
  const decoder = new TextDecoder()
  let pending = ''
  let record = new Map()
  const finish = () => {
    if (!record.size) return
    const path = record.get('Path')
    const size = Number(record.get('Size'))
    if (!path || !Number.isSafeInteger(size) || size < 0) throw archiveFailure('invalid')
    const attributes = record.get('Attributes') || ''
    const special = /^[A-Z_.]*D[A-Z_.]*(?:\s|$)|(?:^|\s)[dlbcps][rwxstST-]{9}(?:\s|$)/.test(attributes)
    if (record.get('Folder') !== '+' && !record.get('Symbolic Link') && !record.get('Hard Link') && !record.get('Copy Link') &&
      !special) onEntry({ path, name: downloadName(path), size })
    record = new Map()
  }
  const line = value => {
    if (!value.trim()) return finish()
    const split = value.indexOf(' = ')
    const key = value.slice(0, split)
    if (split < 0 || !['Path', 'Size', 'Folder', 'Symbolic Link', 'Hard Link', 'Copy Link', 'Attributes'].includes(key)) return
    if (record.has(key)) throw archiveFailure('invalid')
    record.set(key, value.slice(split + 3))
  }
  const consume = bytes => {
    pending += decoder.decode(bytes, { stream: true })
    let end
    while ((end = pending.indexOf('\n')) !== -1) {
      line(pending.slice(0, end).replace(/\r$/, ''))
      pending = pending.slice(end + 1)
    }
    if (pending.length > 16384) throw archiveFailure('invalid')
  }
  command(engine, ['l', '-slt', '-ba', '-bsp0', '-mmt=1', '-sccUTF-8', ...(format ? [`-t${format}`] : []), `-p${password}`, '--', archivePath], consume)
  pending += decoder.decode()
  if (pending) line(pending)
  finish()
}

export function extractEntry (engine, archivePath, path, password, write, format) {
  const args = ['x', '-so', '-y', '-spd', '-ssc', '-bso0', '-bsp0', '-mmt=1', ...(format ? [`-t${format}`] : []), `-p${password}`, '--', archivePath]
  if (path !== null) args.push(path)
  command(engine, args, write)
}

export async function * manifestEntries (file) {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line) yield JSON.parse(line)
      }
      if (pending.length > 32768) throw archiveFailure('invalid')
      if (done) break
    }
    if (pending) throw archiveFailure('invalid')
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

export async function manifestPage (file, query, page) {
  let count = 0
  const entries = []
  for await (const entry of manifestEntries(file)) {
    if (!entry.path.toLowerCase().includes(query.toLowerCase())) continue
    if (count >= page * PAGE_SIZE && entries.length < PAGE_SIZE) entries.push(entry)
    count++
  }
  return { entries, count }
}
