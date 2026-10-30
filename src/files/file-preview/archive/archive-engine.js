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

export function checkSignature (bytes, format) {
  const starts = signature => signature.every((byte, index) => bytes[index] === byte)
  const valid = format === 'zip'
    ? starts([0x50, 0x4b, 3, 4]) || starts([0x50, 0x4b, 5, 6])
    : format === 'rar'
      ? starts([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0]) || starts([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 1, 0])
      : format === 'tar.gz' && starts([0x1f, 0x8b, 8])
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
export function listArchive (engine, archivePath, password, onEntry) {
  const decoder = new TextDecoder()
  let pending = ''
  let record = new Map()
  const finish = () => {
    if (!record.size) return
    const path = record.get('Path')
    const size = Number(record.get('Size'))
    if (!path || !Number.isSafeInteger(size) || size < 0) throw archiveFailure('invalid')
    if (record.get('Folder') !== '+' && !record.get('Symbolic Link') && !record.get('Hard Link') && !record.get('Copy Link') &&
      !/\bl[rwx-]{9}/.test(record.get('Attributes') || '')) onEntry({ path, name: downloadName(path), size })
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
  command(engine, ['l', '-slt', '-ba', '-bsp0', '-sccUTF-8', `-p${password}`, '--', archivePath], consume)
  pending += decoder.decode()
  if (pending) line(pending)
  finish()
}

export function extractEntry (engine, archivePath, path, password, write) {
  const args = ['x', '-so', '-y', '-spd', '-ssc', '-bso0', '-bsp0', '-mmt=1', `-p${password}`, '--', archivePath]
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
