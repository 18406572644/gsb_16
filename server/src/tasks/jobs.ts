/**
 * 转换任务执行体：导入解析 / 导出渲染。
 * 与任务调度解耦 —— TaskManager 负责状态机，这里只负责「干活」。
 */
import type { DocSession } from '../docSession'
import { parseDocument } from '../convert/importers'
import { exportDocument } from '../convert/exporters'
import { lineDiff } from '../../../shared/linediff'
import type { TaskManager, RunContext } from './taskManager'
import { FatalConvertError } from './errors'
import type { ConvertTask, ExportVariant } from '../../../shared/transfer'

export interface JobDeps {
  getSession: (docId: string) => DocSession
  /** 惰性获取 TaskManager（产物写入），打破构造期循环依赖 */
  tasks: () => TaskManager
}

const yieldToEventLoop = () => new Promise((r) => setImmediate(r))

export const runImportJob =
  (deps: JobDeps) =>
  async (task: ConvertTask, payload: Buffer, ctx: RunContext): Promise<void> => {
    ctx.report('读取文件', 10)
    ctx.checkCanceled()
    await yieldToEventLoop()

    ctx.report('解析文档内容', 35)
    const parsed = parseDocument(payload, task.format)
    ctx.checkCanceled()
    await yieldToEventLoop()

    ctx.report('生成结构差异', 70)
    const session = deps.getSession(task.docId)
    const baseRevision = session.revision
    const diff = lineDiff(session.doc, parsed.text)
    ctx.checkCanceled()

    ctx.report('生成预览', 90)
    task.preview = {
      text: parsed.text,
      baseRevision,
      encoding: parsed.encoding,
      lineEnding: parsed.lineEnding,
      warnings: parsed.warnings,
      stats: { ...parsed.stats },
      diff: { lines: diff.lines, stats: diff.stats },
    }
    ctx.report('完成', 100)
  }

export const runExportJob =
  (deps: JobDeps) =>
  async (task: ConvertTask, ctx: RunContext): Promise<void> => {
    const session = deps.getSession(task.docId)
    const variant: ExportVariant = task.variant ?? 'current'

    let text: string
    let revision = session.revision
    if (variant === 'history') {
      const rev = task.revision
      if (typeof rev !== 'number') throw new FatalConvertError('历史导出缺少修订号')
      const rebuilt = session.textAt(rev)
      if (rebuilt === null) {
        throw new FatalConvertError(`历史版本 v${rev} 已超出服务端保留范围，无法导出`, 'REVISION_UNAVAILABLE')
      }
      text = rebuilt
      revision = rev
    } else {
      text = session.doc
    }
    ctx.report('收集版本与批注', 30)
    ctx.checkCanceled()
    await yieldToEventLoop()

    ctx.report(variant === 'annotated' ? '渲染批注锚点' : '渲染文档', 60)
    const file = exportDocument({
      text,
      format: task.format,
      variant,
      revision,
      annotations: variant === 'annotated' ? [...session.annotations.values()] : [],
      docId: task.docId,
      exportedAt: Date.now(),
    })
    ctx.checkCanceled()
    await yieldToEventLoop()

    ctx.report('写入产物', 90)
    deps.tasks().writeArtifact(task.id, file.data)
    task.revision = revision
    task.result = {
      fileName: file.fileName,
      contentType: file.contentType,
      downloadUrl: `/api/docs/${encodeURIComponent(task.docId)}/tasks/${task.id}/download`,
      size: file.data.length,
      revision,
      variant,
    }
    ctx.report('完成', 100)
  }
