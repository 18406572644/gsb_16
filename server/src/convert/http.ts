/**
 * 转换中心 HTTP 路由：/api/convert/*
 *
 * 身份：协同系统本身无独立账号，HTTP 请求携带与 WebSocket join 相同的身份头
 *   x-actor-name（URI 编码）、x-actor-role（viewer/commenter/editor），
 * 导入确认等敏感操作在服务端二次校验角色。
 *
 * 全部接口同源（生产由 Node 托管、开发经 vite 代理），不设置 CORS。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConvertService, Actor } from './convertService'
import { ServiceError } from './convertService'
import { detectFormat } from './convert'
import type { TaskStore } from './taskStore'
import type { AuditLog } from './audit'
import type { ExportRequestBody, ImportFormat } from '../../../shared/convert'
import type { Role } from '../../../shared/protocol'

const MAX_UPLOAD = 50 * 1024 * 1024
const MAX_JSON = 1024 * 1024

interface MultipartFile {
  field: string
  filename: string
  contentType: string
  data: Buffer
}

interface Deps {
  service: ConvertService
  tasks: TaskStore
  audit: AuditLog
}

export function createConvertHandler(deps: Deps) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/convert/')) return false

    const sendJson = (status: number, body: unknown) => {
      const json = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(json)
    }

    const fail = (e: unknown) => {
      if (e instanceof ServiceError) {
        sendJson(e.status, { error: e.message, code: e.code })
      } else {
        console.error('[convert] 接口异常:', e)
        sendJson(500, { error: '服务器内部错误', code: 'INTERNAL' })
      }
    }

    try {
      const actor = readActor(req, sendJson)
      if (!actor) return true
      const p = url.pathname

      /* ---------- 导入 ---------- */
      if (p === '/api/convert/import/preview' && req.method === 'POST') {
        const docId = url.searchParams.get('docId') || 'demo'
        const ct = req.headers['content-type'] || ''
        if (!ct.startsWith('multipart/form-data')) {
          sendJson(400, { error: '需要 multipart/form-data 上传', code: 'BAD_REQUEST' })
          return true
        }
        const body = await readBody(req, MAX_UPLOAD)
        const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct)
        if (!m) return sendJson(400, { error: '缺少 multipart boundary', code: 'BAD_REQUEST' }), true
        const parts = parseMultipart(body, (m[1] || m[2]!).trim())
        const file = parts.files.find((f) => f.field === 'file')
        if (!file) return sendJson(400, { error: '缺少上传文件（字段名 file）', code: 'BAD_REQUEST' }), true
        let format: ImportFormat | null = parts.fields.format as ImportFormat
        if (format && !['txt', 'md', 'html', 'docx', 'pptx', 'xlsx'].includes(format)) {
          format = null
        }
        if (!format) format = detectFormat(file.filename)
        if (!format) {
          sendJson(415, { error: `不支持的文件类型：${file.filename}`, code: 'UNSUPPORTED' })
          return true
        }
        const out = await deps.service.upload(docId, actor, file.filename, format, file.data)
        sendJson(200, out)
        return true
      }

      if (p === '/api/convert/import/task' && req.method === 'GET') {
        const id = url.searchParams.get('id') || ''
        const task = deps.tasks.get(id)
        if (!task) return sendJson(404, { error: '任务不存在', code: 'NOT_FOUND' }), true
        const preview = task.status === 'succeeded' && task.previewId
          ? deps.service.getTaskPreview(id, actor)
          : undefined
        sendJson(200, { task, preview })
        return true
      }

      if (p === '/api/convert/import/refresh' && req.method === 'POST') {
        const { previewId } = await readJson<{ previewId: string }>(req)
        sendJson(200, deps.service.refreshPreview(previewId, actor))
        return true
      }

      if (p === '/api/convert/import/confirm' && req.method === 'POST') {
        const { previewId } = await readJson<{ previewId: string }>(req)
        sendJson(200, deps.service.confirmPreview(previewId, actor))
        return true
      }

      if (p === '/api/convert/import/discard' && req.method === 'POST') {
        const { previewId } = await readJson<{ previewId: string }>(req)
        deps.service.discardPreview(previewId, actor)
        sendJson(200, { ok: true })
        return true
      }

      /* ---------- 导出 ---------- */
      if (p === '/api/convert/export' && req.method === 'POST') {
        const docId = url.searchParams.get('docId') || 'demo'
        const body = await readJson<ExportRequestBody>(req)
        if (!['txt', 'md', 'html'].includes(body.format)) {
          sendJson(400, { error: '不支持的导出格式', code: 'BAD_REQUEST' })
          return true
        }
        if (!['current', 'revision', 'annotated'].includes(body.variant)) {
          sendJson(400, { error: '非法导出版本类型', code: 'BAD_REQUEST' })
          return true
        }
        const out = deps.service.exportSync(
          {
            docId,
            format: body.format,
            variant: body.variant,
            revision: body.revision,
            async: body.async,
          },
          actor,
        )
        if ('taskId' in out) {
          sendJson(202, out)
        } else {
          sendFile(res, out.fileName, out.contentType, out.body)
        }
        return true
      }

      /* ---------- 任务 ---------- */
      const taskMatch = /^\/api\/convert\/tasks\/([^/]+)(\/(retry|cancel|download))?$/.exec(p)
      if (p === '/api/convert/tasks' && req.method === 'GET') {
        sendJson(200, { tasks: deps.tasks.list(url.searchParams.get('docId') || undefined) })
        return true
      }
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1])
        const sub = taskMatch[3]
        const task = deps.tasks.get(id)
        if (!task) return sendJson(404, { error: '任务不存在', code: 'NOT_FOUND' }), true
        if (!sub && req.method === 'GET') {
          sendJson(200, { task })
          return true
        }
        if (sub === 'retry' && req.method === 'POST') {
          sendJson(200, { task: deps.service.retryTask(id, actor) })
          return true
        }
        if (sub === 'cancel' && req.method === 'POST') {
          sendJson(200, { task: deps.service.cancelTask(id, actor) })
          return true
        }
        if (sub === 'download' && req.method === 'GET') {
          const loaded = task.resultId ? deps.tasks.loadArtifact(task.resultId) : null
          if (!loaded) return sendJson(404, { error: '产物不存在或已被清理', code: 'NOT_FOUND' }), true
          deps.service.recordDownload(id, actor)
          sendFile(res, loaded.meta.fileName, loaded.meta.contentType, loaded.buffer)
          return true
        }
      }

      /* ---------- 历史版本 ---------- */
      if (p === '/api/convert/revisions' && req.method === 'GET') {
        const docId = url.searchParams.get('docId') || 'demo'
        sendJson(200, { revisions: deps.service.listRevisions(docId) })
        return true
      }

      /* ---------- 审计 ---------- */
      if (p === '/api/convert/audit' && req.method === 'GET') {
        sendJson(200, {
          records: deps.audit.list({
            docId: url.searchParams.get('docId') || undefined,
            limit: Number(url.searchParams.get('limit') || 100),
          }),
        })
        return true
      }

      sendJson(404, { error: '接口不存在', code: 'NOT_FOUND' })
      return true
    } catch (e) {
      fail(e)
      return true
    }
  }
}

/* ---------------- 辅助 ---------------- */

function readActor(
  req: IncomingMessage,
  sendJson: (status: number, body: unknown) => void,
): Actor | null {
  const name = decodeActorName(String(req.headers['x-actor-name'] || ''))
  const role = String(req.headers['x-actor-role'] || 'editor') as Role
  if (!name) {
    sendJson(401, { error: '缺少身份信息（x-actor-name）', code: 'PERMISSION_DENIED' })
    return null
  }
  if (!['viewer', 'commenter', 'editor'].includes(role)) {
    sendJson(401, { error: '非法角色', code: 'PERMISSION_DENIED' })
    return null
  }
  return { name, role }
}

/**
 * 解析身份名：前端统一百分号编码（ASCII 传输）；
 * 兼容未编码的原始 UTF-8 头——Node 按 latin1 读出头部，此时按 UTF-8 重新解码。
 */
function decodeActorName(raw: string): string {
  let name = raw
  if (raw.includes('%')) {
    try {
      name = decodeURIComponent(raw)
    } catch {
      name = raw
    }
  }
  if (/[\x80-\xff]/.test(name)) {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8')
    if (!utf8.includes('�')) name = utf8
  }
  return name.trim().slice(0, 24)
}

function sendFile(res: ServerResponse, fileName: string, contentType: string, body: Buffer) {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\/:*?"<>|]/g, '_')
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new ServiceError(413, 'BAD_REQUEST', `上传内容过大（上限 ${Math.round(max / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req, MAX_JSON)
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch {
    throw new ServiceError(400, 'BAD_REQUEST', '请求体不是合法 JSON')
  }
}

/** 极简 multipart/form-data 解析（二进制安全，支持 UTF-8 文件名） */
export function parseMultipart(
  buf: Buffer,
  boundary: string,
): { fields: Record<string, string>; files: MultipartFile[] } {
  const fields: Record<string, string> = {}
  const files: MultipartFile[] = []
  const delim = Buffer.from(`--${boundary}`)
  const CRLF = Buffer.from('\r\n')

  let pos = buf.indexOf(delim)
  if (pos < 0) throw new ServiceError(400, 'BAD_REQUEST', 'multipart 分界缺失')
  pos += delim.length

  while (pos < buf.length) {
    // 结束标记 "--"
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break
    // 每个分界后应跟 CRLF
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), pos)
    if (headerEnd < 0) break
    const headerText = buf.subarray(pos, headerEnd).toString('utf8')
    const bodyStart = headerEnd + 4
    const nextDelim = buf.indexOf(delim, bodyStart)
    if (nextDelim < 0) break
    // 正文以 \r\n 结尾（后接分界）
    const bodyEnd = nextDelim - 2
    const data = buf.subarray(bodyStart, bodyEnd)

    const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? ''
    const filenameStar = /filename\*=UTF-8''([^;]+)/i.exec(headerText)
    const filename = filenameStar
      ? decodeURIComponent(filenameStar[1].trim())
      : /filename="([^"]*)"/i.exec(headerText)?.[1] ?? ''
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? 'application/octet-stream'

    if (filename) {
      files.push({ field: name, filename, contentType, data: Buffer.from(data) })
    } else {
      fields[name] = data.toString('utf8')
    }
    pos = nextDelim + delim.length
  }
  return { fields, files }
}
