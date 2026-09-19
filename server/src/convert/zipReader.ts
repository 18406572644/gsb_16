/**
 * 极简 ZIP 读取器（仅满足 .docx 解包需求）。
 * 支持 stored（method=0）与 deflate（method=8），含 ZIP64 额外字段的基础解析。
 * 不做解压完整性之外的校验；不信任的归档只提取需要的条目，且有数量/大小上限。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

export interface ZipEntry {
  name: string
  data: Buffer
}

const MAX_ENTRIES = 100_000
const MAX_TOTAL = 300 * 1024 * 1024

function findEOCD(buf: Buffer): number {
  // EOCD 位于文件尾部（注释最长 65535）
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let p = buf.length - 22; p >= min; p--) {
    if (buf.readUInt32LE(p) === EOCD_SIG) return p
  }
  throw new Error('ZIP: 未找到 EOCD（不是合法的 zip/docx 文件）')
}

interface CentralEntry {
  name: string
  method: number
  compressed: number
  uncompressed: number
  localOffset: number
}

export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEOCD(buf)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  let cdCount = buf.readUInt16LE(eocd + 10)

  // ZIP64：32 位字段为 0xFFFFFFFF 时从 EOCD64 读取（简单定位）
  if (cdOffset === 0xffffffff || cdCount === 0xffff) {
    let p = -1
    for (let k = eocd - 20; k >= 0; k--) {
      if (buf.readUInt32LE(k) === 0x06064b50) {
        p = k
        break
      }
    }
    if (p < 0) throw new Error('ZIP64: 未找到 ZIP64 EOCD')
    cdCount = Number(buf.readBigUInt64LE(p + 32))
    cdOffset = Number(buf.readBigUInt64LE(p + 48))
  }

  const entries: CentralEntry[] = []
  let cursor = cdOffset
  for (let n = 0; n < cdCount; n++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CD_SIG) {
      throw new Error('ZIP: 中央目录结构损坏')
    }
    const method = buf.readUInt16LE(cursor + 10)
    let compressed = buf.readUInt32LE(cursor + 20)
    let uncompressed = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    let localOffset = buf.readUInt32LE(cursor + 42)
    const flags = buf.readUInt16LE(cursor + 8)
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'utf8', cursor + 46, cursor + 46 + nameLen)

    // ZIP64 额外字段：按需覆盖 0xffffffff 字段
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
      let ex = cursor + 46 + nameLen
      const exEnd = ex + extraLen
      while (ex + 4 <= exEnd) {
        const id = buf.readUInt16LE(ex)
        const size = buf.readUInt16LE(ex + 2)
        let v = ex + 4
        if (id === 0x0001) {
          if (uncompressed === 0xffffffff) {
            uncompressed = Number(buf.readBigUInt64LE(v))
            v += 8
          }
          if (compressed === 0xffffffff) {
            compressed = Number(buf.readBigUInt64LE(v))
            v += 8
          }
          if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(v + 16))
        }
        ex += 4 + size
      }
    }

    entries.push({ name, method, compressed, uncompressed, localOffset })
    cursor += 46 + nameLen + extraLen + commentLen
  }

  if (entries.length > MAX_ENTRIES) throw new Error('ZIP: 条目数超出上限')

  const out = new Map<string, Buffer>()
  let total = 0
  for (const e of entries) {
    if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP: ${e.name} 本地文件头损坏`)
    }
    const localNameLen = buf.readUInt16LE(e.localOffset + 26)
    const localExtraLen = buf.readUInt16LE(e.localOffset + 28)
    const dataStart = e.localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + e.compressed > buf.length) throw new Error(`ZIP: ${e.name} 数据越界`)
    const raw = buf.subarray(dataStart, dataStart + e.compressed)
    let data: Buffer
    if (e.method === 0) {
      data = Buffer.from(raw)
    } else if (e.method === 8) {
      data = inflateRawSync(raw)
    } else {
      // 不支持的压缩方式（bzip2/lzma 等）：跳过该条目
      continue
    }
    total += data.length
    if (total > MAX_TOTAL) throw new Error('ZIP: 解压总大小超出上限')
    out.set(e.name, data)
  }
  return out
}
