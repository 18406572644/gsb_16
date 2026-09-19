/**
 * 文档导入导出 / 异步转换中心：客户端与服务端共享的类型定义。
 * 本文件禁止引入任何环境相关 API。
 */

/** 支持导入的格式 */
export type ImportFormat = 'txt' | 'md' | 'html' | 'docx' | 'pptx' | 'xlsx'

/** 支持导出的格式 */
export type ExportFormat = 'txt' | 'md' | 'html'

/** 导出版本范围 */
export type ExportVariant = 'current' | 'revision' | 'annotated'

export const IMPORT_FORMAT_LABEL: Record<ImportFormat, string> = {
  txt: '纯文本 (.txt)',
  md: 'Markdown (.md)',
  html: 'HTML 网页 (.html/.htm)',
  docx: 'Word 文档 (.docx)',
  pptx: 'PowerPoint 演示 (.pptx)',
  xlsx: 'Excel 表格 (.xlsx)',
}

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  txt: '纯文本 TXT',
  md: 'Markdown',
  html: 'HTML 网页',
}

/** 任务种类 */
export type TaskKind = 'import' | 'export'

/** 任务状态机：queued → processing ⇄ retrying → succeeded / failed / cancelled */
export type TaskStatus =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  processing: '处理中',
  retrying: '等待重试',
  succeeded: '已完成',
  failed: '已失败',
  cancelled: '已取消',
}

/** 结构差异块（按行对齐 LCS） */
export interface DiffBlock {
  /** equal 保留 / added 导入稿新增 / removed 现稿将被删除 */
  type: 'equal' | 'added' | 'removed'
  /** 现稿行号（从 0 起），added 为 null */
  oldLine: number | null
  /** 导入稿行号（从 0 起），removed 为 null */
  newLine: number | null
  text: string
}

/** 导入解析统计 */
export interface ImportStats {
  /** 解析出的正文字符数 */
  chars: number
  lines: number
  /** 识别到的链接数 */
  links: number
  /** 识别到的图片数 */
  images: number
  /** 办公文档解析出的附件/内嵌图片等降级提示 */
  warnings: string[]
}

/**
 * 导入预览：解析不直接覆盖正文，先生成预览 + 结构差异 + 待确认版本。
 * pendingText 为待确认的目标正文全文；用户确认后服务端据此生成协同操作。
 */
export interface ImportPreview {
  previewId: string
  docId: string
  format: ImportFormat
  sourceName: string
  sourceSize: number
  /** 解析时依据的当前协同版本；确认时校验，期间正文已演进则需重新预览 */
  baseRevision: number
  pendingText: string
  diff: DiffBlock[]
  stats: ImportStats
  createdAt: number
}

/** 外部变更来源（随协同操作广播，标识本次变更由导入/回滚等外部动作产生） */
export interface ExternalChangeInfo {
  kind: 'import' | 'rollback'
  /** 关联的导入预览 / 任务 ID */
  refId: string
  sourceName?: string
  /** 操作用户展示名 */
  userName: string
}

/** 异步转换任务 */
export interface ConvertTask {
  id: string
  kind: TaskKind
  status: TaskStatus
  docId: string
  /** 发起者展示名（HTTP 层由调用方传入，与协同身份一致） */
  ownerName: string
  /** 导入任务：源文件名；导出任务：导出文件名 */
  fileName: string
  format: ImportFormat | ExportFormat
  /** 导出任务专用 */
  variant?: ExportVariant
  revision?: number
  /** 已尝试次数（首次执行为 1） */
  attempts: number
  maxAttempts: number
  error: string | null
  /** 导入任务成功后关联的预览 ID（仍需用户确认才进入正文） */
  previewId?: string
  /** 导出任务成功后用于下载的产物 ID */
  resultId?: string
  resultSize?: number
  createdAt: number
  updatedAt: number
  /** processing 阶段开始时间（用于长耗时进度提示） */
  startedAt?: number
  finishedAt?: number
  /** 取消令牌版本：每次取消/重试时变化，执行方据此中止旧执行 */
  token: number
}

/** 审计动作 */
export type AuditAction =
  | 'import.upload'
  | 'import.confirm'
  | 'import.cancel'
  | 'export.run'
  | 'export.download'
  | 'task.create'
  | 'task.retry'
  | 'task.cancel'
  | 'task.fail'
  | 'task.done'

export interface AuditRecord {
  id: string
  ts: number
  action: AuditAction
  docId: string
  actor: string
  taskId?: string
  /** 操作目标详情（文件名、格式、版本、差异统计等） */
  detail?: Record<string, unknown>
  ok: boolean
  error?: string
}

/** 历史版本元信息（一个已接受的协同操作 = 一个版本步进） */
export interface RevisionInfo {
  revision: number
  authorName: string
  clientId: string
  opId: string
  ts: number
  lenBefore: number
  lenAfter: number
  /** 外部变更标记（导入等） */
  external?: ExternalChangeInfo
}

/* ---------------- HTTP API 契约 ---------------- */

export const API = {
  importPreview: '/api/convert/import/preview',
  importConfirm: '/api/convert/import/confirm',
  importDiscard: '/api/convert/import/discard',
  importRefresh: '/api/convert/import/refresh',
  importTaskPreview: '/api/convert/import/task',
  exportRun: '/api/convert/export',
  tasks: '/api/convert/tasks',
  taskItem: (id: string) => `/api/convert/tasks/${encodeURIComponent(id)}`,
  taskDownload: (id: string) => `/api/convert/tasks/${encodeURIComponent(id)}/download`,
  revisions: '/api/convert/revisions',
  audit: '/api/convert/audit',
} as const

export interface ImportConfirmBody {
  previewId: string
}

export interface ExportRequestBody {
  format: ExportFormat
  variant: ExportVariant
  /** variant = revision 时指定版本号 */
  revision?: number
  /** 异步任务方式（长文档默认走任务） */
  async?: boolean
}

export interface ApiError {
  error: string
  code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'BAD_REQUEST' | 'CONFLICT' | 'UNSUPPORTED' | 'INTERNAL'
}
