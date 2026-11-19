import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const MAX_INDEX = 16 * 1024 * 1024
const MAX_SESSION = 24 * 1024 * 1024
const SESSION = /^chat_sessions\/([^/]+)\.json$/u
const ZIP_NAME = /^deepseek[_-]data.*\.zip$/iu
const ZIP_EXTENSION = /\.zip$/iu
const SKIP_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

export async function listArchives(directory, signal) {
  let rootEntries
  try {
    rootEntries = await readdir(directory, { withFileTypes: true })
  } catch {
    throw new Error('读不到手机下载目录。请到 DSH Go 设置里开启「访问手机文件」。')
  }
  const candidates = []
  async function scan(path, entries, depth, relativeDirectory) {
    for (const entry of entries) {
      signal?.throwIfAborted()
      const child = join(path, entry.name)
      try {
        if (entry.isDirectory() && depth < 3) {
          const nested = await readdir(child, { withFileTypes: true })
          const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
          await scan(child, nested, depth + 1, relative)
        } else if (entry.isFile() && ZIP_EXTENSION.test(entry.name)) {
          const status = await stat(child)
          candidates.push({ path: child, name: entry.name, mtime: status.mtimeMs, relativeDirectory })
        }
      } catch (error) {
        if (!SKIP_FILE_ERRORS.has(error.code)) throw error
      }
    }
  }
  await scan(directory, rootEntries, 0, '')
  candidates.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  const archives = []
  for (const candidate of candidates) {
    signal?.throwIfAborted()
    if (ZIP_NAME.test(candidate.name) || await hasSessions(candidate.path)) {
      archives.push(candidate)
      if (archives.length === 20) break
    }
  }
  return archives
}

async function hasSessions(path) {
  try {
    const file = await open(path, 'r')
    try {
      const status = await file.stat()
      if (!status.isFile()) return false
      const entries = await directoryOf(file, status.size)
      entries.delete('chat_session_index.json')
      return entries.size > 0
    } finally {
      await file.close()
    }
  } catch {
    // An unrelated or incomplete ZIP should not prevent finding other exports.
    return false
  }
}

async function readExact(file, size, offset, length) {
  if (offset < 0 || offset + length > size) throw new Error('ZIP 不完整，请重新下载。')
  if (Buffer.isBuffer(file)) return file.subarray(offset, offset + length)
  const bytes = Buffer.alloc(length)
  let written = 0
  while (written < length) {
    const result = await file.read(bytes, written, length - written, offset + written)
    if (!result.bytesRead) throw new Error('ZIP 读到一半，文件可能已被移走。')
    written += result.bytesRead
  }
  return bytes
}

async function directoryOf(file, size) {
  const start = Math.max(0, size - 65557)
  const tail = await readExact(file, size, start, size - start)
  let end = tail.length - 22
  for (; end >= 0; end--) {
    if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break
  }
  if (end < 0) throw new Error('找不到 ZIP 目录，请重新下载。')
  const count = tail.readUInt16LE(end + 10)
  const length = tail.readUInt32LE(end + 12)
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count === 65535 || length > MAX_INDEX) {
    throw new Error('此导出使用了超大或分卷 ZIP 格式。')
  }
  const raw = await readExact(file, size, tail.readUInt32LE(end + 16), length)
  const entries = new Map()
  let cursor = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > raw.length || raw.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录已损坏。')
    const nameSize = raw.readUInt16LE(cursor + 28)
    const next = cursor + 46 + nameSize + raw.readUInt16LE(cursor + 30) + raw.readUInt16LE(cursor + 32)
    if (next > raw.length) throw new Error('ZIP 目录已损坏。')
    const name = raw.toString('utf8', cursor + 46, cursor + 46 + nameSize)
    if (SESSION.test(name) || name === 'chat_session_index.json') {
      if (entries.has(name)) throw new Error('导出包中有重复的会话文件。')
      entries.set(name, {
        flags: raw.readUInt16LE(cursor + 8), method: raw.readUInt16LE(cursor + 10),
        packed: raw.readUInt32LE(cursor + 20), unpacked: raw.readUInt32LE(cursor + 24),
        offset: raw.readUInt32LE(cursor + 42),
      })
    }
    cursor = next
  }
  return entries
}

async function jsonEntry(file, size, entry, limit) {
  if (entry.flags & 1 || ![0, 8].includes(entry.method)) throw new Error('ZIP 压缩格式无法读取。')
  if (entry.packed > limit || entry.unpacked > limit) throw new Error('这段对话的导出文件过大。请先选一段短对话测试。')
  const header = await readExact(file, size, entry.offset, 30)
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 条目已损坏。')
  const base = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  const packed = await readExact(file, size, base, entry.packed)
  const clear = entry.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.unpacked) })
  if (clear.length !== entry.unpacked) throw new Error('ZIP 条目的文件大小校验失败。')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear))
}

export async function readArchive(archive, conversation) {
  if (archive.bytes) return readArchiveContents(archive.bytes, archive.bytes.length, conversation)
  const file = await open(archive.path, 'r')
  try {
    const status = await file.stat()
    if (!status.isFile() || status.mtimeMs !== archive.mtime) throw new Error('导出包有变化，请重新选择。')
    return await readArchiveContents(file, status.size, conversation)
  } finally {
    await file.close()
  }
}

async function readArchiveContents(file, size, conversation) {
  const entries = await directoryOf(file, size)
  if (conversation) {
    const entry = entries.get(conversation.name)
    if (!entry) throw new Error('这段对话已找不到，请重新选择导出包。')
    const value = await jsonEntry(file, size, entry, MAX_SESSION)
    if (String(value?.id) !== conversation.id) throw new Error('会话编号与导出目录不一致。')
    return value
  }
  const indexEntry = entries.get('chat_session_index.json')
  const index = indexEntry ? await jsonEntry(file, size, indexEntry, MAX_INDEX) : []
  const metadata = new Map(Array.isArray(index) ? index.map(row => [String(row?.id), row]) : [])
  const rows = []
  for (const name of entries.keys()) {
    const match = SESSION.exec(name)
    if (!match) continue
    const id = match[1]
    const row = metadata.get(id)
    const title = typeof row?.title === 'string' ? row.title.trim() : ''
    rows.push({ name, id, title: title || `未命名对话 ${rows.length + 1}`, at: Date.parse(row?.updated_at) || 0 })
  }
  if (!rows.length) throw new Error('这个 ZIP 里没有新版 DeepSeek 会话，请在原 DeepSeek 里重新导出。')
  return rows.sort((a, b) => b.at - a.at)
}
