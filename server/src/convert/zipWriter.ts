/**
 * 极简 ZIP 写出器（stored / deflate），用于生成 .docx。
 * 单盘、无加密、无 ZIP64（导出文档大小远低于 4GB）。
 */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipFileItem {
  name: string
  data: Buffer
}

export class ZipWriter {
  private items: ZipFileItem[] = []

  addFile(name: string, data: Buffer | string) {
    this.items.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })
  }

  /** 生成 zip Buffer（deflate 压缩；不可压缩或过小的内容回退 stored） */
  buffer(): Buffer {
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0

    for (const item of this.items) {
      const nameBuf = Buffer.from(item.name, 'utf8')
      const crc = crc32(item.data)
      const deflated = deflateRawSync(item.data, { level: 6 })
      const useDeflate = deflated.length < item.data.length && item.data.length > 16
      const method = useDeflate ? 8 : 0
      const payload = useDeflate ? deflated : item.data

      // 本地文件头（30 字节 + 名称）
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4) // version needed
      local.writeUInt16LE(0x0800, 6) // UTF-8 名称标志
      local.writeUInt16LE(method, 8)
      // 时间/日期：使用固定基准（1980-01-01），导出内容不依赖宿主时钟
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0x21, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(item.data.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)

      locals.push(local, nameBuf, payload)

      // 中央目录头（46 字节 + 名称）
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4) // version made by
      central.writeUInt16LE(20, 6) // version needed
      central.writeUInt16LE(0x0800, 8)
      central.writeUInt16LE(method, 10)
      central.writeUInt16LE(0, 12)
      central.writeUInt16LE(0x21, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(payload.length, 20)
      central.writeUInt32LE(item.data.length, 24)
      central.writeUInt16LE(nameBuf.length, 28)
      central.writeUInt16LE(0, 30) // extra
      central.writeUInt16LE(0, 32) // comment
      central.writeUInt16LE(0, 34) // disk
      central.writeUInt16LE(0, 36) // internal attrs
      central.writeUInt32LE(0, 38) // external attrs
      central.writeUInt32LE(offset, 42)
      centrals.push(central, nameBuf)

      offset += local.length + nameBuf.length + payload.length
    }

    const centralBuf = Buffer.concat(centrals)
    const localBuf = Buffer.concat(locals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.items.length, 8)
    eocd.writeUInt16LE(this.items.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(localBuf.length, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([localBuf, centralBuf, eocd])
  }
}
