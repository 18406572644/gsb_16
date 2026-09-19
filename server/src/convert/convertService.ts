/**
 * 转换服务：编排 DocSession（版本/正文/批注）、TaskStore（异步任务）、
 * AuditLog（审计）与导入预览的生命周期。
 *
 * 导入流程（解析不覆盖正文）：
 *   上传 → 解析 → 生成预览（待确认正文 + 结构差异 + 统计，记录 baseRevision）
 *   → 用户确认 → 校验编辑权限与版本新鲜度 → commitExternal 作为协同操作广播；
 *   期间正文已演进可刷新预览（依据待确认文本对当前正文重算差异）。
 *
 * 长耗时 / 大体量转换（办公文档、超大文本、显式 async）走异步任务。
 */
import { randomUUID } from 'node:crypto'
import type { Annotation } from '../../../shared/protocol'
import type {
  AuditAction,
  ConvertTask,
  ExportFormat,
  ExportVariant,
  ImportFormat,
  ImportPreview,
} from '../../../shared/convert'
import type { DocSession } from '../docSession'
import { diffLines } from './diff'
import { exportDocument, parseImport, type ExportResult } from './convert'
import type { AuditLog } from './audit'
import type { TaskStore } from './taskStore'

/** 超过该体积的文本类导入/同步导出走异步任务（办公文档恒为异步） */
const ASYNC_THRESHOLD = 200 * 1024
/** 超长文档行数提示阈值（不阻断，仅在统计中告警） */
const LONG_DOC_LINES = 20_000

export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface Actor {
  name: string
  role: 'viewer' | 'commenter' | 'editor'
}

export interface ExportParams {
  docId: string
  format: ExportFormat
  variant: ExportVariant
  /** variant = revision 时指定版本号 */
  revision?: number
  /** 显式要求异步任务方式 */
  async?: boolean
}

interface PreparedExport {
  text: string
  annotations?: Annotation[]
}

export class ConvertService {
  /** 异步导入任务的源文件缓冲（仅存于内存；进程重启后任务需重新上传） */
  private uploadBufs = new Map<string, Buffer>()

  constructor(
    private tasks: TaskStore,
    private audit: AuditLog,
    private getSession: (docId: string) => DocSession,
  ) {
    tasks.registerExecutor('import', (ctx) => this.runImportTask(ctx))
    tasks.registerExecutor('export', (ctx) => this.runExportTask(ctx))
    tasks.onTransition = (t, prev, detail) => this.onTaskTransition(t, prev, detail)
  }

  private log(
    action: AuditAction,
    docId: string,
    actor: Actor | string,
    ok: boolean,
    detail?: Record<string, unknown>,
    error?: string,
    taskId?: string,
  ) {
    this.audit.record({
      action,
      docId,
      actor: typeof actor === 'string' ? actor : actor.name,
      ok,
      detail,
      error,
      taskId,
    })
  }

  /* ---------------- 导入 ---------------- */

  /** 上传并解析：小文本同步返回预览；办公文档/大文件返回 taskId 走异步 */
  async upload(
    docId: string,
    actor: Actor,
    sourceName: string,
    format: ImportFormat,
    buf: Buffer,
  ): Promise<{ preview?: ImportPreview; taskId?: string }> {
    if (actor.role !== 'editor') {
      this.log('import.upload', docId, actor, false, { sourceName, format, size: buf.length }, '无编辑权限')
      throw new ServiceError(403, 'PERMISSION_DENIED', '仅编辑者可以导入文档')
    }
    const heavy = format !== 'txt' && format !== 'md' && format !== 'html'
    if (heavy || buf.length > ASYNC_THRESHOLD) {
      const task = this.tasks.enqueue({
        kind: 'import',
        docId,
        ownerName: actor.name,
        fileName: sourceName,
        format,
      })
      this.uploadBufs.set(task.id, buf)
      this.log('task.create', docId, actor, true, {
        taskId: task.id,
        kind: 'import',
        sourceName,
        format,
        size: buf.length,
      })
      return { taskId: task.id }
    }
    try {
      const preview = await this.buildPreview(docId, sourceName, format, buf)
      this.log('import.upload', docId, actor, true, {
        previewId: preview.previewId,
        sourceName,
        format,
        size: buf.length,
        chars: preview.stats.chars,
        lines: preview.stats.lines,
      })
      return { preview }
    } catch (e) {
      this.log('import.upload', docId, actor, false, { sourceName, format, size: buf.length }, (e as Error).message)
      if (e instanceof ServiceError) throw e
      throw new ServiceError(400, 'BAD_REQUEST', `文件解析失败：${(e as Error).message}`)
    }
  }

  private async runImportTask(ctx: {
    task: ConvertTask
    checkpoint: () => void
  }): Promise<{ preview: ImportPreview }> {
    const t = ctx.task
    const buf = this.uploadBufs.get(t.id)
    if (!buf) throw new Error('任务源文件已丢失（服务器可能重启过），请重新上传')
    ctx.checkpoint()
    const format = t.format as ImportFormat
    const parsed = await parseImport(buf, format)
    ctx.checkpoint()
    this.uploadBufs.delete(t.id)
    const preview = this.makePreview(t.docId, t.fileName, format, buf.length, parsed.text, parsed.stats)
    return { preview }
  }

  private async buildPreview(
    docId: string,
    sourceName: string,
    format: ImportFormat,
    buf: Buffer,
  ): Promise<ImportPreview> {
    const parsed = await parseImport(buf, format)
    return this.makePreview(docId, sourceName, format, buf.length, parsed.text, parsed.stats)
  }

  private makePreview(
    docId: string,
    sourceName: string,
    format: ImportFormat,
    sourceSize: number,
    pendingText: string,
    stats: ImportPreview['stats'],
  ): ImportPreview {
    const session = this.getSession(docId)
    const warnings = [...stats.warnings]
    if (stats.lines > LONG_DOC_LINES) {
      warnings.push(`文档较长（${stats.lines} 行），确认时将作为单次协同变更提交，请留意其他协作者客户端的渲染耗时`)
    }
    const preview: ImportPreview = {
      previewId: randomUUID(),
      docId,
      format,
      sourceName,
      sourceSize,
      baseRevision: session.revision,
      pendingText,
      diff: diffLines(session.doc, pendingText),
      stats: { ...stats, warnings },
      createdAt: Date.now(),
    }
    this.tasks.savePreview(preview)
    return preview
  }

  /** 取任务产出的导入预览（任务完成后调用） */
  getTaskPreview(taskId: string, actor: Actor): ImportPreview {
    const t = this.tasks.get(taskId)
    if (!t) throw new ServiceError(404, 'NOT_FOUND', '任务不存在')
    if (t.kind !== 'import' || !t.previewId) throw new ServiceError(409, 'CONFLICT', '该任务尚无可用预览')
    const p = this.tasks.loadPreview(t.previewId)
    if (!p) throw new ServiceError(404, 'NOT_FOUND', '预览已失效，请重新上传')
    void actor
    return p
  }

  /** 预览过期（期间正文已演进）：依据待确认文本对当前正文重算差异 */
  refreshPreview(previewId: string, actor: Actor): ImportPreview {
    const p = this.tasks.loadPreview(previewId)
    if (!p) throw new ServiceError(404, 'NOT_FOUND', '预览不存在或已过期，请重新上传')
    const session = this.getSession(p.docId)
    p.baseRevision = session.revision
    p.diff = diffLines(session.doc, p.pendingText)
    p.createdAt = Date.now()
    this.tasks.savePreview(p)
    this.log('import.upload', p.docId, actor, true, {
      previewId,
      action: 'refresh',
      baseRevision: p.baseRevision,
    })
    return p
  }

  /** 用户确认：预览文本作为协同变更提交（纳入版本与权限体系） */
  confirmPreview(previewId: string, actor: Actor): { revision: number; changed: boolean } {
    const p = this.tasks.loadPreview(previewId)
    if (!p) throw new ServiceError(404, 'NOT_FOUND', '预览不存在或已确认，请重新上传')
    if (actor.role !== 'editor') {
      this.log('import.confirm', p.docId, actor, false, { previewId }, '无编辑权限')
      throw new ServiceError(403, 'PERMISSION_DENIED', '仅编辑者可以确认导入')
    }
    const session = this.getSession(p.docId)
    if (p.baseRevision !== session.revision) {
      this.log('import.confirm', p.docId, actor, false, {
        previewId,
        baseRevision: p.baseRevision,
        current: session.revision,
      }, '预览已过期')
      throw new ServiceError(409, 'CONFLICT', '预览生成后正文已有新版本，请刷新预览差异后再确认')
    }
    const result = session.commitExternal(actor.name, p.pendingText, {
      kind: 'import',
      refId: p.previewId,
      sourceName: p.sourceName,
      userName: actor.name,
    })
    this.tasks.deletePreview(previewId)
    this.log('import.confirm', p.docId, actor, true, {
      previewId,
      sourceName: p.sourceName,
      format: p.format,
      revision: result.revision,
      changed: result.changed,
      added: p.diff.filter((d) => d.type === 'added').length,
      removed: p.diff.filter((d) => d.type === 'removed').length,
    })
    return { revision: result.revision, changed: result.changed }
  }

  discardPreview(previewId: string, actor: Actor) {
    const p = this.tasks.loadPreview(previewId)
    if (!p) return
    this.tasks.deletePreview(previewId)
    this.log('import.cancel', p.docId, actor, true, { previewId, sourceName: p.sourceName })
  }

  /* ---------------- 导出 ---------------- */

  /** 同步导出小文档；其余情况返回 taskId */
  exportSync(params: ExportParams, actor: Actor): ExportResult | { taskId: string } {
    if (params.async) return this.enqueueExport(params, actor)
    const prepared = this.prepareExport(params)
    if (prepared.text.length > ASYNC_THRESHOLD) return this.enqueueExport(params, actor)
    try {
      const result = this.renderExport(params, prepared)
      this.log('export.run', params.docId, actor, true, {
        format: params.format,
        variant: params.variant,
        revision: params.revision,
        size: result.body.length,
      })
      return result
    } catch (e) {
      this.log('export.run', params.docId, actor, false, {
        format: params.format,
        variant: params.variant,
      }, (e as Error).message)
      throw e
    }
  }

  private enqueueExport(params: ExportParams, actor: Actor): { taskId: string } {
    const task = this.tasks.enqueue({
      kind: 'export',
      docId: params.docId,
      ownerName: actor.name,
      fileName: params.docId,
      format: params.format,
      variant: params.variant,
      revision: params.revision,
    })
    this.log('task.create', params.docId, actor, true, {
      taskId: task.id,
      kind: 'export',
      format: params.format,
      variant: params.variant,
      revision: params.revision,
    })
    return { taskId: task.id }
  }

  private async runExportTask(ctx: {
    task: ConvertTask
    checkpoint: () => void
  }): Promise<{ artifact: { fileName: string; contentType: string; buffer: Buffer } }> {
    const t = ctx.task
    const params: ExportParams = {
      docId: t.docId,
      format: t.format as ExportFormat,
      variant: t.variant ?? 'current',
      revision: t.revision,
    }
    const prepared = this.prepareExport(params)
    ctx.checkpoint()
    const result = this.renderExport(params, prepared)
    return {
      artifact: {
        fileName: result.fileName,
        contentType: result.contentType,
        buffer: result.body,
      },
    }
  }

  /** 组装导出正文与批注（按变体） */
  private prepareExport(params: ExportParams): PreparedExport {
    const session = this.getSession(params.docId)
    if (params.variant === 'revision') {
      if (typeof params.revision !== 'number') {
        throw new ServiceError(400, 'BAD_REQUEST', '历史版本导出需要指定版本号')
      }
      const text = session.docAtRevision(params.revision)
      if (text === null) {
        throw new ServiceError(404, 'NOT_FOUND', '该历史版本已超出服务端保留范围（最近 1000 个版本）')
      }
      return { text }
    }
    if (params.variant === 'annotated') {
      return { text: session.doc, annotations: session.annotationsAtRevision(session.revision) }
    }
    return { text: session.doc }
  }

  private renderExport(params: ExportParams, prepared: PreparedExport): ExportResult {
    return exportDocument(params.docId, prepared.text, params.format, {
      annotations: prepared.annotations,
      revision: params.variant === 'revision' ? params.revision : undefined,
      withAnnotations: params.variant === 'annotated',
    })
  }

  /* ---------------- 版本与任务审计 ---------------- */

  listRevisions(docId: string) {
    return this.getSession(docId).revisions()
  }

  retryTask(taskId: string, actor: Actor): ConvertTask {
    const t = this.tasks.get(taskId)
    if (!t) throw new ServiceError(404, 'NOT_FOUND', '任务不存在')
    try {
      const next = this.tasks.retry(taskId)
      this.log('task.retry', t.docId, actor, true, { taskId, kind: t.kind, attempts: next.attempts }, undefined, taskId)
      return next
    } catch (e) {
      const se = e as { status?: number; message?: string }
      this.log('task.retry', t.docId, actor, false, { taskId }, se.message, taskId)
      throw new ServiceError(se.status ?? 409, 'CONFLICT', se.message || '任务当前状态不可重试')
    }
  }

  cancelTask(taskId: string, actor: Actor): ConvertTask {
    const t = this.tasks.get(taskId)
    if (!t) throw new ServiceError(404, 'NOT_FOUND', '任务不存在')
    try {
      const next = this.tasks.cancel(taskId)
      this.log('task.cancel', t.docId, actor, true, { taskId, kind: t.kind, status: next.status }, undefined, taskId)
      return next
    } catch (e) {
      const se = e as { status?: number; message?: string }
      this.log('task.cancel', t.docId, actor, false, { taskId }, se.message, taskId)
      throw new ServiceError(se.status ?? 409, 'CONFLICT', se.message || '任务当前状态不可取消')
    }
  }

  /** 产物下载审计（成功取到产物时调用） */
  recordDownload(taskId: string, actor: Actor) {
    const t = this.tasks.get(taskId)
    if (t) this.log('export.download', t.docId, actor, true, { taskId, fileName: t.fileName }, undefined, taskId)
  }

  private onTaskTransition(t: ConvertTask, prev: string, detail?: string) {
    if (t.status === 'succeeded' && prev !== 'succeeded') {
      this.log('task.done', t.docId, t.ownerName, true, {
        taskId: t.id,
        kind: t.kind,
        attempts: t.attempts,
        size: t.resultSize,
      }, undefined, t.id)
    } else if (t.status === 'failed' && prev !== 'failed') {
      // 彻底失败（重试已耗尽）：释放导入源文件缓冲
      this.uploadBufs.delete(t.id)
      this.log('task.fail', t.docId, t.ownerName, false, {
        taskId: t.id,
        kind: t.kind,
        attempts: t.attempts,
      }, detail || t.error || undefined, t.id)
    } else if (t.status === 'cancelled' && prev !== 'cancelled') {
      this.uploadBufs.delete(t.id)
    }
  }
}
