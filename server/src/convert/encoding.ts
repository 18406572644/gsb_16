/**
 * 字节 → 文本解码：处理中文环境常见编码。
 *
 * 优先级：BOM 显式声明 > UTF-8 严格校验 > GB18030 回退（GBK 超集，
 * Windows 中文系统默认）。Node 内置全量 ICU，TextDecoder 支持 gb18030。
 */
import type { ConvertWarning } from '../../../shared/transfer'

export interface DecodeResult {
  text: string
  encoding: string
  warnings: ConvertWarning[]
}

/** 严格校验 UTF-8：返回 true 表示整个 buffer 是合法 UTF-8 */
export function isValidUtf8(buf: Buffer): boolean {
  let i = 0
  while (i < buf.length) {
    const b0 = buf[i]
    if (b0 <= 0x7f) {
      i++
      continue
    }
    let len: number
    let minCp: number
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      len = 2
      minCp = 0x80
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      len = 3
      minCp = b0 === 0xe0 ? 0x800 : 0x80
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      len = 4
      minCp = b0 === 0xf0 ? 0x10000 : 0x10000
    } else {
      return false
    }
    if (i + len > buf.length) return false
    let cp = b0 & (0x7f >> len)
    for (let k = 1; k < len; k++) {
      const bk = buf[i + k]
      if (bk < 0x80 || bk > 0xbf) return false
      cp = (cp << 6) | (bk & 0x3f)
    }
    if (cp < minCp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false
    i += len
  }
  return true
}

function decodeWith(label: string, buf: Buffer): string {
  return new TextDecoder(label, { fatal: false }).decode(buf)
}

export function decodeBytes(buf: Buffer): DecodeResult {
  const warnings: ConvertWarning[] = []

  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: decodeWith('utf-8', buf.subarray(3)), encoding: 'utf-8-bom', warnings }
  }
  // UTF-16 LE/BE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: decodeWith('utf-16le', buf.subarray(2)), encoding: 'utf-16le', warnings }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: decodeWith('utf-16be', buf.subarray(2)), encoding: 'utf-16be', warnings }
  }

  if (isValidUtf8(buf)) {
    return { text: decodeWith('utf-8', buf), encoding: 'utf-8', warnings }
  }

  // 非 UTF-8：中文场景优先按 GB18030（GBK 超集）解读
  try {
    const text = decodeWith('gb18030', buf)
    warnings.push({
      code: 'ENCODING_FALLBACK',
      message: '文件不是 UTF-8 编码，已按 GB18030/GBK 尝试解码，请核对中文是否正常',
    })
    return { text, encoding: 'gb18030', warnings }
  } catch {
    const text = decodeWith('utf-8', buf)
    warnings.push({
      code: 'ENCODING_FALLBACK',
      message: '无法识别文件编码，已按 UTF-8 容错解码，部分字符可能乱码',
    })
    return { text, encoding: 'utf-8-replace', warnings }
  }
}

/**
 * 规范化文本：
 * - 统一保留 \\n（记录原始换行风格供预览展示）；
 * - 移除 BOM；
 * - 删除非法/不可见控制字符（保留 \\t \\n \\r），产生兼容性警告；
 * - 超长文本截断。
 */
export interface NormalizeResult {
  text: string
  lineEnding: 'LF' | 'CRLF' | 'CR'
  truncated: boolean
  warnings: ConvertWarning[]
}

export function normalizeText(raw: string, maxChars: number): NormalizeResult {
  const warnings: ConvertWarning[] = []
  let text = raw
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const hasCrlf = text.includes('\r\n')
  const hasCrOnly = /\r(?!\n)/.test(text)
  const lineEnding: NormalizeResult['lineEnding'] = hasCrlf ? 'CRLF' : hasCrOnly ? 'CR' : 'LF'

  // 非法控制字符（保留 \t \n \r）
  let bad = 0
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, () => {
    bad++
    return ''
  })
  if (bad > 0) {
    warnings.push({ code: 'UNSUPPORTED_CHAR', message: `已移除 ${bad} 个不可见/非法控制字符`, count: bad })
  }

  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
    warnings.push({
      code: 'TRUNCATED',
      message: `文档超过 ${maxChars.toLocaleString()} 字符上限，已截断`,
    })
  }

  // 超长单行提示（diff 与渲染压力点）
  const lines = text.split(/\r\n|\r|\n/)
  const overlong = lines.filter((l) => l.length > 50_000).length
  if (overlong > 0) {
    warnings.push({
      code: 'OVERLONG_LINE',
      message: `检测到 ${overlong} 行超过 5 万字符的超长行，差异对比可能降级展示`,
      count: overlong,
    })
  }

  return { text, lineEnding, truncated, warnings }
}
