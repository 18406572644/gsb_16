/**
 * 转换中心 REST API。
 *
 * 鉴权：与演示身份体系一致，请求头携带 x-user-name / x-user-role；
 * 缺失时按「匿名 viewer」处理（导入/确认等编辑类接口将被拒绝）。
 *
 * 路由：
 *   GET    /api/docs/:docId                          文档信息与可导出历史点
 *   POST   /api/docs/:docId/imports                  上传文件创建导入任务（editor）
 *   POST   /api/docs/:docId/imports/:taskId/confirm  确认导入 → 协同变更（editor）
 *   POST   /api/docs/:docId/imports/:taskId/discard  放弃导入预览
 *   POST   /api/docs/:docId/exports                  创建导出任务（viewer+）
 *   GET    /api/docs/:docId/tasks                    任务列表
 *   POST   /api/docs/:docId/tasks/:taskId/cancel     取消任务
 *   POST   /api/docs/:docId/tasks/:taskId/retry      手动重试
 *   GET    /api/docs/:docId/tasks/:taskId/download   下载导出产物
 *   GET    /api/docs/:docId/audit                    审计记录
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import type { DocSession } from '../docSession'
import { parseMultipart, readJson } from './multipart'
import { HttpFailure } from './errors'
import { AuditLog } from '../tasks/audit'
import type { TaskManager } from '../tasks/taskManager'
import type {
  ApiErrorBody,
  AuditEntry,
  ConvertTask,
  DocFormat,
  ExportVariant,
} from '../../../shared/transfer'
import type { Role } from '../../../shared/protocol'
import {
  EXT_TO_FORMAT,
  FORMAT_LABEL,
  MAX_IMPORT_BYTES,
  MAX_TEXT_CHARS,
} from '../../../shared/transfer'

interface RouteDeps {
  getSession: (docId: string) => DocSession
  tasks: TaskManager
  audit: AuditLog
}

interface Identity {
  name: string
  role: Role
}

const error = (statusCode: number, code: ApiErrorBody['error']['code'], message: string): HttpFailure =>
  new HttpFailure(statusCode, code, message)

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  })
  res.end(buf)
}

function sendError(res: ServerResponse, e: HttpFailure) {
  sendJson(res, e.statusCode, { error: { code: e.code, message: e.message } } satisfies ApiErrorBody)
}

function identityOf(req: IncomingMessage): Identity {
  const rawName = String(req.headers['x-user-name'] || '匿名')
  // 客户端按 RFC 5987 风格 encodeURIComponent（头只能 Latin-1）；未编码时原样使用
  let name = rawName
  try {
    if (/%[0-9a-fA-F]{2}/.test(rawName)) name = decodeURIComponent(rawName)
  } catch {
    /* 保留原值 */
  }
  const roleRaw = String(req.headers['x-user-role'] || 'viewer')
  const role: Role = roleRaw === 'editor' || roleRaw === 'commenter' ? roleRaw : 'viewer'
  return { name: name.slice(0, 24), role }
}

export function createTransferHandler(deps: RouteDeps) {
  const { getSession, tasks, audit } = deps

  function auditOf(
    actor: Identity,
    action: AuditEntry['action'],
    docId: string,
    status: AuditEntry['status'],
    extra: Partial<AuditEntry> = {},
  ) {
    audit.append({ docId, action, actor: actor.name, role: actor.role, status, ...extra })
  }

  function requireEditor(actor: Identity) {
    if (actor.role !== 'editor') {
      throw error(403, 'PERMISSION_DENIED', '该操作需要「编辑」权限')
    }
  }

  function getOwnedTask(docId: string, taskId: string): ConvertTask {
    const t = tasks.get(taskId)
    if (!t || t.docId !== docId) throw error(404, 'NOT_FOUND', '任务不存在')
    return t
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname
    const method = req.method || 'GET'
    const m = p.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/)
    if (!m) return false
    const docId = decodeURIComponent(m[1])
    const rest = m[2] || ''

    const actor = identityOf(req)
    // 访问 API 即确保会话已加载（与 WS 同一文档存储）
    const session = getSession(docId)

    try {
      /* ---- 文档信息 ---- */
      if (rest === '' && method === 'GET') {
        sendJson(res, 200, {
          docId,
          revision: session.revision,
          chars: session.doc.length,
          history: session.historyPoints().map((h) => ({
            revision: h.revision,
            chars: h.chars,
            annotations: h.revision === session.revision ? session.annotations.size : 0,
            createdAt: null,
          })),
          annotations: [...session.annotations.values()],
        })
        return true
      }

      /* ---- 创建导入任务 ---- */
      if (rest === 'imports' && method === 'POST') {
        requireEditor(actor)
        const mp = await parseMultipart(req, MAX_IMPORT_BYTES + 1024)
        if (!mp.file) throw error(400, 'BAD_REQUEST', '未收到上传文件')
        const ext = extname(mp.file.filename).toLowerCase()
        const hint = (mp.fields.format || '').toLowerCase()
        const format: DocFormat | undefined =
          EXT_TO_FORMAT[ext] ?? (['txt', 'md', 'html', 'docx'].includes(hint) ? (hint as DocFormat) : undefined)
        if (!format) {
          throw error(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            `不支持的文件类型「${ext || '未知'}」，支持：txt / md / html / docx（老式 .doc 请先另存为 .docx）`,
          )
        }
        if (mp.file.data.length === 0) throw error(400, 'BAD_REQUEST', '文件内容为空')
        if (format === 'docx' && mp.file.data.length < 4) {
          throw error(400, 'BAD_REQUEST', 'docx 文件不合法（体积过小）')
        }
        const task = tasks.createTask(
          {
            kind: 'import',
            format,
            docId,
            ownerName: actor.name,
            ownerRole: actor.role,
            sourceName: mp.file.filename,
            sourceSize: mp.file.data.length,
          },
          mp.file.data,
        )
        auditOf(actor, 'import.submit', docId, 'ok', {
          taskId: task.id,
          kind: 'import',
          format,
          detail: `${mp.file.filename}（${(mp.file.data.length / 1024).toFixed(1)} KB，${FORMAT_LABEL[format]}）`,
        })
        sendJson(res, 202, { task })
        return true
      }

      /* ---- 确认 / 放弃导入 ---- */
      const confirmM = rest.match(/^imports\/([^/]+)\/(confirm|discard)$/)
      if (confirmM && method === 'POST') {
        // 确认与放弃都属于导入写流程，仅 editor
        requireEditor(actor)
        const task = getOwnedTask(docId, confirmM[1])
        const action = confirmM[2]
        if (task.kind !== 'import') throw error(404, 'NOT_FOUND', '任务不存在')

        if (action === 'discard') {
          if (task.status !== 'succeeded' || !task.preview) throw error(409, 'CONFLICT', '当前任务状态不可放弃')
          if (task.discardedAt) throw error(409, 'CONFLICT', '预览已放弃')
          task.discardedAt = Date.now()
          auditOf(actor, 'import.discard', docId, 'ok', { taskId: task.id, kind: 'import', format: task.format })
          sendJson(res, 200, { ok: true })
          return true
        }

        // confirm
        if (task.status !== 'succeeded' || !task.preview) {
          throw error(409, 'CONFLICT', '解析尚未完成或任务已失败，无法确认')
        }
        if (task.discardedAt) throw error(409, 'CONFLICT', '预览已放弃，请重新导入')
        const body = await readJson(req)
        const newText =
          typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT_CHARS) : task.preview.text

        const result = session.submitExternalChange(
          { clientId: `rest-${task.id}`, name: actor.name, role: actor.role },
          newText,
        )
        if ('code' in result) {
          auditOf(actor, 'import.confirm', docId, 'error', {
            taskId: task.id,
            kind: 'import',
            format: task.format,
            detail: result.message,
          })
          throw error(
            result.code === 'PERMISSION_DENIED' ? 403 : 409,
            result.code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'CONFLICT',
            result.message,
          )
        }
        // 预览一次性消费，避免重复确认
        task.discardedAt = Date.now()
        auditOf(actor, 'import.confirm', docId, 'ok', {
          taskId: task.id,
          kind: 'import',
          format: task.format,
          revision: result.baseRevision,
          newRevision: result.revision,
          detail: `v${result.baseRevision} → v${result.revision}`,
        })
        sendJson(res, 200, result)
        return true
      }

      /* ---- 创建导出任务 ---- */
      if (rest === 'exports' && method === 'POST') {
        const body = await readJson(req)
        const format = body.format as DocFormat
        const variant = body.variant as ExportVariant
        if (!format || !['txt', 'md', 'html', 'docx'].includes(format)) {
          throw error(400, 'BAD_REQUEST', '缺少或非法的 format')
        }
        if (!variant || !['current', 'history', 'annotated'].includes(variant)) {
          throw error(400, 'BAD_REQUEST', '缺少或非法的 variant')
        }
        let revision: number | undefined
        if (variant === 'history') {
          revision = Number(body.revision)
          if (!Number.isInteger(revision) || session.textAt(revision) === null) {
            throw error(404, 'NOT_FOUND', '指定的历史版本不存在或已超出保留范围')
          }
        }
        const task = tasks.createTask({
          kind: 'export',
          format,
          docId,
          ownerName: actor.name,
          ownerRole: actor.role,
          sourceName: `${docId}.${format}`,
          sourceSize: session.doc.length,
          variant,
          revision,
        })
        auditOf(actor, 'export.submit', docId, 'ok', {
          taskId: task.id,
          kind: 'export',
          format,
          variant,
          revision,
        })
        sendJson(res, 202, { task })
        return true
      }

      /* ---- 任务列表 ---- */
      if (rest === 'tasks' && method === 'GET') {
        const fullId = url.searchParams.get('full')
        // 列表轮询裁掉导入预览重字段（预览全文/差异行可能达数 MB），仅当前查看的任务返回完整数据
        const list = tasks.list(docId).map((t) => {
          if (fullId && t.id === fullId) return t
          if (!t.preview) return t
          return {
            ...t,
            preview: {
              baseRevision: t.preview.baseRevision,
              encoding: t.preview.encoding,
              lineEnding: t.preview.lineEnding,
              warnings: t.preview.warnings,
              stats: t.preview.stats,
              text: '',
              diff: { lines: [], stats: t.preview.diff.stats },
              omitted: true,
            },
          }
        })
        sendJson(res, 200, { tasks: list })
        return true
      }

      /* ---- 取消 / 重试 ---- */
      const opM = rest.match(/^tasks\/([^/]+)\/(cancel|retry)$/)
      if (opM && method === 'POST') {
        const task = getOwnedTask(docId, opM[1])
        const r =
          opM[2] === 'cancel' ? tasks.cancel(task.id) : tasks.retry(task.id)
        if (!r.ok) throw error(409, 'CONFLICT', r.message)
        auditOf(actor, opM[2] === 'cancel' ? 'task.cancel' : 'task.retry', docId, 'ok', {
          taskId: task.id,
          kind: task.kind,
          format: task.format,
        })
        sendJson(res, 200, { task: tasks.get(task.id) })
        return true
      }

      /* ---- 下载产物 ---- */
      const dlM = rest.match(/^tasks\/([^/]+)\/download$/)
      if (dlM && method === 'GET') {
        const task = getOwnedTask(docId, dlM[1])
        if (task.kind !== 'export') throw error(404, 'NOT_FOUND', '任务不存在')
        if (task.status !== 'succeeded' || !task.result) {
          throw error(
            409,
            'CONFLICT',
            task.status === 'expired' ? '产物已过期，请重新导出' : '任务尚未完成',
          )
        }
        const data = tasks.readArtifact(task.id)
        if (!data) {
          task.status = 'expired'
          task.result = undefined
          throw error(410, 'NOT_FOUND', '产物文件已失效，请重新导出')
        }
        auditOf(actor, 'export.download', docId, 'ok', {
          taskId: task.id,
          kind: 'export',
          format: task.format,
          variant: task.variant,
          revision: task.result.revision,
        })
        const filename = task.result.fileName
        res.writeHead(200, {
          'content-type': task.result.contentType,
          'content-length': data.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'cache-control': 'private, max-age=300',
        })
        res.end(data)
        return true
      }

      /* ---- 审计 ---- */
      if (rest === 'audit' && method === 'GET') {
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200)
        const entries = await audit.read(docId, limit)
        sendJson(res, 200, { entries })
        return true
      }

      sendError(res, error(404, 'NOT_FOUND', '接口不存在'))
      return true
    } catch (e) {
      if (e instanceof HttpFailure) {
        sendError(res, e)
      } else {
        console.error('[api] 处理异常:', e)
        sendError(res, error(500, 'INTERNAL', '服务器内部错误'))
      }
      return true
    }
  }
}
