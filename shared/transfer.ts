/**
 * 文档导入 / 导出与异步转换中心的共享类型（前后端通用，禁止引入环境 API）。
 *
 * 核心流程：
 *   导入：上传 → 异步解析 → 生成「解析预览 + 结构差异 + 待确认版本」→ 用户确认
 *         → 作为一条协同变更（OT op）提交，进入版本与权限体系；
 *   导出：当前版本 / 历史版本 / 带批注版本，均产出可下载文件；
 *   长耗时转换：统一走异步任务（排队 / 执行 / 重试 / 取消 / 审计）。
 */
import type { Op } from './ot'
import type { Annotation } from './protocol'

/** 支持的文档格式 */
export type DocFormat = 'txt' | 'md' | 'html' | 'docx'

export const FORMAT_LABEL: Record<DocFormat, string> = {
  txt: '纯文本',
  md: 'Markdown',
  html: 'HTML 网页',
  docx: 'Word (.docx)',
}

/** 常见办公文档扩展名 → 内部格式（.doc/.wps 等不支持的老式格式会在服务端拒绝） */
export const EXT_TO_FORMAT: Record<string, DocFormat> = {
  '.txt': 'txt',
  '.text': 'txt',
  '.log': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.mkd': 'md',
  '.htm': 'html',
  '.html': 'html',
  '.xhtml': 'html',
  '.docx': 'docx',
}

/** 导出内容变体 */
export type ExportVariant = 'current' | 'history' | 'annotated'

export const EXPORT_VARIANT_LABEL: Record<ExportVariant, string> = {
  current: '当前版本',
  history: '历史版本',
  annotated: '带批注版本',
}

/* ---------------- 结构差异（导入预览） ---------------- */

/** 差异块类型：上下文保持 / 新增行 / 删除行；行内变化的行同时给删除+新增相邻呈现。
 *  skip 为「折叠的未变化区间」（超长文档预览），skipped 为被折叠的行数 */
export type DiffLineOp = 'equal' | 'insert' | 'delete' | 'skip'

export interface DiffLine {
  op: DiffLineOp
  /** oldSide 为旧文行号（0 起），newSide 为新文行号；不存在的一侧或 skip 行为 -1 */
  oldNo: number
  newNo: number
  text: string
  /** 仅 skip：被折叠的行数 */
  skipped?: number
}

export interface DocDiffStats {
  /** 新增行数 */
  inserted: number
  /** 删除行数 */
  deleted: number
  /** 未变化行数 */
  equal: number
  /** 两版总行数（较大者，用于变化百分比） */
  totalLines: number
  /** 旧文/新文字符数 */
  oldChars: number
  newChars: number
}

/* ---------------- 转换警告（兼容性提示，不阻断流程） ---------------- */

export type ConvertWarningCode =
  | 'ENCODING_FALLBACK'
  | 'UNSUPPORTED_CHAR'
  | 'LINK_DROPPED'
  | 'IMAGE_DROPPED'
  | 'IMAGE_PLACEHOLDER'
  | 'STYLE_DROPPED'
  | 'TRUNCATED'
  | 'COMMENT_DROPPED'
  | 'OVERLONG_LINE'
  | 'GENERIC'

export interface ConvertWarning {
  code: ConvertWarningCode
  message: string
  /** 可选定位（行号 0 起 / 数量） */
  line?: number
  count?: number
}

/* ---------------- 异步任务 ---------------- */

export type TaskKind = 'import' | 'export'
export type TaskStatus =
  | 'pending' // 排队中，等待 worker
  | 'running' // 执行中
  | 'retrying' // 失败后等待自动重试
  | 'succeeded'
  | 'failed' // 重试耗尽，最终失败
  | 'canceled' // 用户取消（排队中或执行中）
  | 'expired' // 产物过期被清理（记录保留）

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '排队中',
  running: '转换中',
  retrying: '重试中',
  succeeded: '已完成',
  failed: '已失败',
  canceled: '已取消',
  expired: '已过期',
}

/** 任务进度：phase 描述阶段，percent 0-100 */
export interface TaskProgress {
  phase: string
  percent: number
}

export interface TaskError {
  message: string
  code?: string
  at: number
}

/**
 * 转换任务。导入任务成功后产物为「预览」（不落正文）；
 * 导出任务成功后产物为文件（downloadUrl）。
 */
export interface ConvertTask {
  id: string
  kind: TaskKind
  format: DocFormat
  status: TaskStatus
  docId: string
  /** 发起者展示名（REST 请求头传入，与 WS join 同一演示身份体系） */
  ownerName: string
  /** 发起者角色快照：导入仅 editor，导出 viewer 及以上 */
  ownerRole: 'viewer' | 'commenter' | 'editor'
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
  progress: TaskProgress
  /** 已执行尝试次数（首次为 1） */
  attempts: number
  maxAttempts: number
  /** 下一次自动重试时间（retrying 状态） */
  nextRetryAt: number | null
  error: TaskError | null
  /** 历次失败信息（含已被重试成功覆盖的） */
  history: TaskError[]
  /** 导入任务原始文件名 */
  sourceName: string
  /** 导入源字节大小 / 导出源文档字符数 */
  sourceSize: number
  /** 导出变体参数 */
  variant?: ExportVariant
  /** 导出历史版本时的目标修订号 */
  revision?: number
  /** 产物：导入预览（succeeded 后可确认/放弃） */
  preview?: ImportPreview
  /** 产物：导出文件下载信息 */
  result?: ExportResult
  /** 导入预览被用户主动放弃的时间（放弃后不可再确认） */
  discardedAt?: number
}

/** 导入解析结果：预览文本 + 与当前正文的结构差异 */
export interface ImportPreview {
  /** 解析出的纯文本（待确认版本），确认时服务端与当时正文 diff 生成 OT op */
  text: string
  /** 解析所基于的正文修订号；确认时若已落后，服务端会重新做 diff */
  baseRevision: number
  encoding: string
  lineEnding: 'LF' | 'CRLF' | 'CR'
  warnings: ConvertWarning[]
  stats: {
    chars: number
    lines: number
    links: number
    images: number
    /** docx 中检出的批注数（当前模型无法自动锚定，默认丢弃并警告） */
    comments: number
  }
  diff: {
    lines: DiffLine[]
    stats: DocDiffStats
  }
  /** 列表轮询裁剪重字段时为 true（text/diff.lines 为空壳，客户端应保留已拉取的完整预览） */
  omitted?: boolean
}

export interface ExportResult {
  fileName: string
  contentType: string
  /** 相对下载地址，如 /api/docs/demo/tasks/t-xxx/download */
  downloadUrl: string
  size: number
  /** 导出时正文修订号 */
  revision: number
  variant: ExportVariant
}

/* ---------------- 操作审计 ---------------- */

export type AuditAction =
  | 'import.submit' // 上传创建导入任务
  | 'import.confirm' // 确认导入（协同变更提交）
  | 'import.discard' // 放弃导入预览
  | 'export.submit' // 创建导出任务
  | 'export.download' // 下载导出产物
  | 'task.retry'
  | 'task.cancel'
  | 'task.fail'
  | 'task.timeout'

export interface AuditEntry {
  id: string
  at: number
  docId: string
  action: AuditAction
  actor: string
  role: 'viewer' | 'commenter' | 'editor'
  taskId?: string
  kind?: TaskKind
  format?: DocFormat
  variant?: ExportVariant
  revision?: number
  /** 确认导入后产生的协同修订号 */
  newRevision?: number
  detail?: string
  status: 'ok' | 'denied' | 'error'
}

/* ---------------- REST 接口载荷 ---------------- */

export interface CreateImportResponse {
  task: ConvertTask
}

export interface CreateExportBody {
  format: DocFormat
  variant: ExportVariant
  /** variant=history 时必填 */
  revision?: number
}

export interface ConfirmImportBody {
  /**
   * 可选：对预览文本的本地编辑（用户在预览框里微调后再确认）。
   * 不传则使用任务产物中的原始预览文本。
   */
  text?: string
}

export interface ConfirmImportResponse {
  /** 确认导入所提交的协同操作 */
  op: Op
  baseRevision: number
  revision: number
  /** 应用后的正文 */
  doc: string
}

export interface TaskListResponse {
  tasks: ConvertTask[]
}

export interface AuditListResponse {
  entries: AuditEntry[]
}

/** 确认导入时随正文一起返回的批注快照（用于客户端校对，正文以 OT 广播为准） */
export interface RevisionInfo {
  revision: number
  chars: number
  annotations: number
  createdAt: number | null
}

export interface DocInfoResponse {
  docId: string
  revision: number
  chars: number
  /** 可导出的历史修订号列表（周期性快照点，含当前版本） */
  history: RevisionInfo[]
  annotations: Annotation[]
}

/** REST 层错误体 */
export interface ApiErrorBody {
  error: {
    code:
      | 'PERMISSION_DENIED'
      | 'BAD_REQUEST'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'PAYLOAD_TOO_LARGE'
      | 'UNSUPPORTED_MEDIA_TYPE'
      | 'INTERNAL'
    message: string
  }
}

/** 导入文件大小上限（字节）：50MB；超长文本解析侧另设字符上限 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024
/** 解析/导出参与 diff 的文本字符上限（超出截断并给 TRUNCATED 警告） */
export const MAX_TEXT_CHARS = 2_000_000
/** LCS 差异计算在放弃精细对齐前允许的最大行积（行数 × 行数） */
export const LCS_CELL_BUDGET = 12_000_000

/** 异步任务限制 */
export const TASK_LIMITS = {
  /** 单文档保留任务数（超出最早的成功任务先过期） */
  perDoc: 100,
  /** 自动重试次数（不含首次执行） */
  maxAttempts: 3,
  /** 重试退避基数 ms：1s、4s、9s（attempt² * base） */
  retryBaseMs: 1000,
  /** 导出产物磁盘保留 ms：30 分钟 */
  artifactTtlMs: 30 * 60 * 1000,
  /** 任务记录保留 ms：24 小时 */
  recordTtlMs: 24 * 60 * 60 * 1000,
  /** 单次转换执行超时 ms */
  runTimeoutMs: 120_000,
}
