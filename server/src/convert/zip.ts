/**
 * 最小 ZIP 读取器（仅用于读取 .docx/.pptx/.xlsx 等 OOXML 包）。
 * 支持 STORE(0) 与 DEFLATE(8) 两种压缩方式；中央目录为权威索引。
 * 不引入第三方解压依赖，DEFLATE 走 Node 内置 zlib。
 */
import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CD = 0x02014b50
const SIG_ZIP64_EOCD = 0x06064b50

interface CentralEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

export class ZipReader {
  private entries = new Map<string, CentralEntry>()
  private cache = new Map<string, Buffer>()

  constructor(private buf: Buffer) {
    this.parseCentralDirectory()
  }

  private readU32(off: number): number {
    return this.buf.readUInt32LE(off)
  }

  private findEocd(): number {
    // EOCD 位于文件尾部，注释最长 64K，自尾向前扫描签名
    const min = Math.max(0, this.buf.length - 65557)
    for (let i = this.buf.length - 22; i >= min; i--) {
      if (this.readU32(i) === SIG_EOCD) return i
    }
    throw new Error('ZIP: 未找到 EOCD 记录，文件可能已损坏')
  }

  private parseCentralDirectory() {
    const eocd = this.findEocd()
    let cdOffset = this.readU32(eocd + 16)
    let cdCount = this.buf.readUInt16LE(eocd + 10)

    // ZIP64：CD 偏移为 0xffffffff 时定位 ZIP64 EOCD
    if (cdOffset === 0xffffffff || cdCount === 0xffff) {
      const z64LocatorOff = eocd - 20
      if (z64LocatorOff >= 0 && this.readU32(z64LocatorOff) === 0x07064b50) {
        const z64Off = Number(this.buf.readBigUInt64LE(z64LocatorOff + 8))
        if (this.readU32(z64Off) === SIG_ZIP64_EOCD) {
          cdCount = Number(this.buf.readBigUInt64LE(z64Off + 32))
          cdOffset = Number(this.buf.readBigUInt64LE(z64Off + 48))
        }
      }
    }

    let p = cdOffset
    for (let n = 0; n < cdCount; n++) {
      if (this.readU32(p) !== SIG_CD) throw new Error('ZIP: 中央目录记录损坏')
      const method = this.buf.readUInt16LE(p + 10)
      const csize = this.readU32(p + 20)
      const usize = this.readU32(p + 24)
      const nameLen = this.buf.readUInt16LE(p + 28)
      const extraLen = this.buf.readUInt16LE(p + 30)
      const commentLen = this.buf.readUInt16LE(p + 32)
      const localOffset = this.readU32(p + 42)
      const name = this.buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

      let realCsize = csize
      let realUsize = usize
      let realOffset = localOffset
      if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
        // 在 extra 字段中查找 ZIP64 扩展（0x0001），按字段顺序填补
        let ep = p + 46 + nameLen
        const epEnd = ep + extraLen
        while (ep + 4 <= epEnd) {
          const tag = this.buf.readUInt16LE(ep)
          const size = this.buf.readUInt16LE(ep + 2)
          if (tag === 0x0001) {
            let dp = ep + 4
            if (usize === 0xffffffff) {
              realUsize = Number(this.buf.readBigUInt64LE(dp))
              dp += 8
            }
            if (csize === 0xffffffff) {
              realCsize = Number(this.buf.readBigUInt64LE(dp))
              dp += 8
            }
            if (localOffset === 0xffffffff) realOffset = Number(this.buf.readBigUInt64LE(dp))
          }
          ep += 4 + size
        }
      }

      this.entries.set(name, {
        name,
        method,
        compressedSize: realCsize,
        uncompressedSize: realUsize,
        localOffset: realOffset,
      })
      p += 46 + nameLen + extraLen + commentLen
    }
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  list(): string[] {
    return [...this.entries.keys()]
  }

  /** 读取包内文件为 UTF-8 文本；不存在返回 null */
  readText(name: string): string | null {
    const b = this.read(name)
    return b ? b.toString('utf8') : null
  }

  read(name: string): Buffer | null {
    const hit = this.cache.get(name)
    if (hit) return hit
    const e = this.entries.get(name)
    if (!e) return null
    // 本地文件头：30 字节固定区 + 文件名 + extra，之后才是数据
    const p = e.localOffset
    if (this.readU32(p) !== 0x04034b50) throw new Error(`ZIP: ${name} 本地文件头损坏`)
    const nameLen = this.buf.readUInt16LE(p + 26)
    const extraLen = this.buf.readUInt16LE(p + 28)
    const dataStart = p + 30 + nameLen + extraLen
    const raw = this.buf.subarray(dataStart, dataStart + e.compressedSize)
    let out: Buffer
    if (e.method === 0) {
      out = Buffer.from(raw)
    } else if (e.method === 8) {
      out = inflateRawSync(raw)
    } else {
      throw new Error(`ZIP: 不支持的压缩方式 ${e.method}（${name}）`)
    }
    this.cache.set(name, out)
    return out
  }
}
