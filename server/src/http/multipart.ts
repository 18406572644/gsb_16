/**
 * 极简 multipart/form-data 解析器（仅满足单文件导入上传）。
 * 不依赖第三方库；限制总大小，二进制部分原样保留 Buffer。
 */
import type { IncomingMessage } from 'node:http'
import { HttpFailure } from './errors'

export interface MultipartFile {
  field: string
  filename: string
  contentType: string
  data: Buffer
}

export interface MultipartResult {
  fields: Record<string, string>
  file: MultipartFile | null
}

export async function parseMultipart(req: IncomingMessage, maxBytes: number): Promise<MultipartResult> {
  const ct = req.headers['content-type'] || ''
  const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!boundaryMatch) {
    throw new HttpFailure(400, 'BAD_REQUEST', '缺少 multipart boundary（请使用文件上传表单）')
  }
  const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]).trim()

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) {
      throw new HttpFailure(413, 'PAYLOAD_TOO_LARGE', `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
    }
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks)
  const delim = Buffer.from(boundary)
  const parts: Buffer[] = []
  const start = body.indexOf(delim)
  if (start < 0) throw new HttpFailure(400, 'BAD_REQUEST', 'multipart 数据不完整')
  // 切分各 part
  let cursor = start + delim.length
  while (cursor < body.length) {
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break // -- 结束
    // 跳过 CRLF
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2
    const next = body.indexOf(delim, cursor)
    if (next < 0) break
    // part 末尾的 CRLF 去掉
    let end = next
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2
    parts.push(body.subarray(cursor, end))
    cursor = next + delim.length
  }

  const fields: Record<string, string> = {}
  let file: MultipartFile | null = null

  for (const part of parts) {
    const headerEnd = indexOfDoubleCrlf(part)
    if (headerEnd < 0) continue
    const headerText = part.subarray(0, headerEnd).toString('utf8')
    const data = part.subarray(headerEnd + 4)
    const nameMatch = headerText.match(/name="([^"]*)"/i)
    const filenameStarMatch = headerText.match(/filename\*=(?:UTF-8'')?([^;\r\n]+)/i)
    const filenameQuotedMatch = headerText.match(/filename="([^"]*)"/i)
    const ctMatch = headerText.match(/content-type:\s*([^\r\n]+)/i)
    if (!nameMatch) continue
    const field = nameMatch[1]
    if (filenameStarMatch || filenameQuotedMatch) {
      // 优先 filename*（RFC 5987 编码），其次普通 filename
      let filename = filenameStarMatch
        ? decodeURIComponent(filenameStarMatch[1].trim())
        : filenameQuotedMatch![1].trim()
      // 兜底：非 ASCII 且未按 RFC5987 编码时按 latin1→utf8 纠正浏览器裸传
      if (/[Ð-ÿ]/.test(filename)) {
        try {
          filename = Buffer.from(filename, 'latin1').toString('utf8')
        } catch {
          /* 保留原值 */
        }
      }
      file = {
        field,
        filename,
        contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data,
      }
    } else {
      fields[field] = data.toString('utf8')
    }
  }

  return { fields, file }
}

function indexOfDoubleCrlf(buf: Buffer): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i
  }
  return -1
}

export async function readJson<T = any>(req: IncomingMessage, maxBytes = 1 << 20): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) throw new HttpFailure(413, 'PAYLOAD_TOO_LARGE', '请求体过大')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T
  } catch {
    throw new HttpFailure(400, 'BAD_REQUEST', '请求体不是合法 JSON')
  }
}
