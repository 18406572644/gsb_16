/**
 * 异步转换任务中心：
 *
 * - 状态机：queued → processing ⇄ retrying → succeeded / failed / cancelled；
 * - 失败自动退避重试（500ms·2^n，上限 30s），默认最多 3 次尝试，可手动重试；
 * - 取消：令牌（token）+ AbortSignal，执行方在各转换步骤间协作式检查，
 *   执行返回后若发现令牌已换代（期间被取消）则丢弃结果；
 * - 产物 / 预览落盘（data/convert/），任务状态持久化，重启后排队任务恢复，
 *   中断在 processing 的任务标记失败、可手动重试；
 * - 审计钩子由调用方在状态流转时写入（onTransition）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ConvertTask,
  ExportFormat,
  ExportVariant,
  ImportFormat,
  ImportPreview,
  TaskKind,
  TaskStatus,
} from '../../../shared/convert'

export interface Artifact {
  id: string
  fileName: string
  contentType: string
  size: number
  createdAt: number
}

export interface TaskParams {
  kind: TaskKind
  docId: string
  ownerName: string
  fileName: string
  format: ImportFormat | ExportFormat
  variant?: ExportVariant
  revision?: number
}

export interface ExecuteContext {
  task: ConvertTask
  signal: AbortSignal
  /** 执行方在长耗时步骤间调用；任务已取消时抛 AbortError */
  checkpoint: () => void
}

export interface ExecuteOutcome {
  /** 导出任务产物 */
  artifact?: { fileName: string; contentType: string; buffer: Buffer }
  /** 导入任务预览 */
  preview?: ImportPreview
}

type Executor = (ctx: ExecuteContext) => Promise<ExecuteOutcome>

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
const PERSIST_DEBOUNCE_MS = 500

export class TaskCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'TaskCancelledError'
  }
}

export class TaskStore {
  private tasks = new Map<string, ConvertTask>()
  private executors = new Map<TaskKind, Executor>()
  /** 每个任务当前执行代次的 AbortController（token 换代即中止旧执行） */
  private controllers = new Map<string, AbortController>()
  private persistTimer: NodeJS.Timeout | null = null
  private dirtyIds = new Set<string>()

  constructor(private dir: string) {
    this.artifactsDir = join(dir, 'artifacts')
    this.previewsDir = join(dir, 'previews')
    mkdirSync(this.artifactsDir, { recursive: true })
    mkdirSync(this.previewsDir, { recursive: true })
    this.recover()
  }

  private artifactsDir: string
  private previewsDir: string

  onTransition: (t: ConvertTask, prev: TaskStatus, detail?: string) => void = () => {}

  registerExecutor(kind: TaskKind, fn: Executor) {
    this.executors.set(kind, fn)
  }

  /* ---------------- 查询 ---------------- */

  get(id: string): ConvertTask | null {
    return this.tasks.get(id) ?? null
  }

  list(docId?: string): ConvertTask[] {
    const all = [...this.tasks.values()]
    all.sort((a, b) => b.createdAt - a.createdAt)
    return docId ? all.filter((t) => t.docId === docId) : all
  }

  /* ---------------- 生命周期 ---------------- */

  enqueue(params: TaskParams): ConvertTask {
    const now = Date.now()
    const task: ConvertTask = {
      id: randomUUID(),
      kind: params.kind,
      status: 'queued',
      docId: params.docId,
      ownerName: params.ownerName,
      fileName: params.fileName,
      format: params.format,
      variant: params.variant,
      revision: params.revision,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      error: null,
      createdAt: now,
      updatedAt: now,
      token: 0,
    }
    this.tasks.set(task.id, task)
    this.persist(task.id)
    this.onTransition(task, 'queued')
    queueMicrotask(() => this.run(task.id, task.token))
    return task
  }

  /** 手动重试失败任务：重置尝试次数，立即重新排队 */
  retry(id: string): ConvertTask {
    const t = this.tasks.get(id)
    if (!t) throw new TaskHttpError(404, '任务不存在')
    if (t.status !== 'failed' && t.status !== 'cancelled') {
      throw new TaskHttpError(409, '仅失败或已取消的任务可以重试')
    }
    const prev = t.status
    t.status = 'queued'
    t.error = null
    t.attempts = 0
    t.token++
    t.updatedAt = Date.now()
    this.bumpTokenAndRun(t)
    this.onTransition(t, prev)
    return t
  }

  /** 取消任务：排队/等待重试直接终结；执行中则中止信号，由执行循环收尾 */
  cancel(id: string): ConvertTask {
    const t = this.tasks.get(id)
    if (!t) throw new TaskHttpError(404, '任务不存在')
    if (t.status === 'succeeded' || t.status === 'failed' || t.status === 'cancelled') {
      throw new TaskHttpError(409, '任务已结束，无法取消')
    }
    const prev = t.status
    t.token++
    if (t.status === 'processing') {
      // 执行中：发中止信号；循环检查到令牌换代后置为 cancelled
      this.controllers.get(id)?.abort()
      // 立即落一个“取消中”语义仍保留 processing，避免 UI 误以为已结束
      t.updatedAt = Date.now()
    } else {
      t.status = 'cancelled'
      t.finishedAt = Date.now()
      t.updatedAt = t.finishedAt
    }
    this.persist(id)
    this.onTransition(t, prev)
    return t
  }

  private bumpTokenAndRun(t: ConvertTask) {
    this.controllers.get(t.id)?.abort()
    this.persist(t.id)
    queueMicrotask(() => this.run(t.id, t.token))
  }

  private async run(id: string, token: number) {
    const t = this.tasks.get(id)
    if (!t || token !== t.token) return
    const executor = this.executors.get(t.kind)
    if (!executor) {
      this.fail(t, token, new Error(`未注册的任务类型: ${t.kind}`))
      return
    }

    t.attempts++
    t.status = 'processing'
    t.startedAt = Date.now()
    t.updatedAt = t.startedAt
    t.error = null
    this.onTransition(t, 'queued')
    this.persist(id)

    const controller = new AbortController()
    this.controllers.set(id, controller)
    const checkpoint = () => {
      if (controller.signal.aborted || t.token !== token) throw new TaskCancelledError()
    }

    try {
      const outcome = await executor({ task: t, signal: controller.signal, checkpoint })
      checkpoint() // 转换刚结束时被取消：丢弃产物
      if (outcome.artifact) {
        const artifactId = randomUUID()
        writeFileSync(join(this.artifactsDir, artifactId), outcome.artifact.buffer)
        const meta: Artifact = {
          id: artifactId,
          fileName: outcome.artifact.fileName,
          contentType: outcome.artifact.contentType,
          size: outcome.artifact.buffer.length,
          createdAt: Date.now(),
        }
        writeFileSync(join(this.artifactsDir, `${artifactId}.json`), JSON.stringify(meta))
        t.resultId = artifactId
        t.resultSize = meta.size
      }
      if (outcome.preview) {
        t.previewId = outcome.preview.previewId
        this.savePreview(outcome.preview)
      }
      t.status = 'succeeded'
      t.finishedAt = Date.now()
      t.updatedAt = t.finishedAt
      this.persist(id)
      this.onTransition(t, 'processing')
    } catch (e) {
      if (e instanceof TaskCancelledError || controller.signal.aborted || t.token !== token) {
        t.status = 'cancelled'
        t.finishedAt = Date.now()
        t.updatedAt = t.finishedAt
        t.error = '用户取消'
        this.persist(id)
        this.onTransition(t, 'processing')
        return
      }
      await this.fail(t, token, e as Error)
    } finally {
      this.controllers.delete(id)
    }
  }

  private async fail(t: ConvertTask, token: number, e: Error) {
    if (t.token !== token) return // 已被重试 / 取消换代
    if (t.attempts < t.maxAttempts) {
      const prev = t.status
      t.status = 'retrying'
      t.error = e.message
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** (t.attempts - 1), MAX_BACKOFF_MS)
      t.updatedAt = Date.now()
      this.persist(t.id)
      this.onTransition(t, prev, `第 ${t.attempts} 次尝试失败：${e.message}`)
      setTimeout(() => {
        if (t.token !== token || t.status !== 'retrying') return
        void this.run(t.id, token)
      }, delay)
    } else {
      const prev = t.status
      t.status = 'failed'
      t.error = e.message
      t.finishedAt = Date.now()
      t.updatedAt = t.finishedAt
      this.persist(t.id)
      this.onTransition(t, prev, e.message)
    }
  }

  /* ---------------- 产物与预览 ---------------- */

  loadArtifact(id: string): { meta: Artifact; buffer: Buffer } | null {
    const metaFile = join(this.artifactsDir, `${id}.json`)
    const binFile = join(this.artifactsDir, id)
    if (!existsSync(metaFile) || !existsSync(binFile)) return null
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Artifact
      return { meta, buffer: readFileSync(binFile) }
    } catch {
      return null
    }
  }

  savePreview(p: ImportPreview) {
    writeFileSync(join(this.previewsDir, `${p.previewId}.json`), JSON.stringify(p))
  }

  loadPreview(id: string): ImportPreview | null {
    const f = join(this.previewsDir, `${id}.json`)
    if (!existsSync(f)) return null
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as ImportPreview
    } catch {
      return null
    }
  }

  deletePreview(id: string) {
    try {
      rmSync(join(this.previewsDir, `${id}.json`), { force: true })
    } catch {
      // 忽略清理失败
    }
  }

  /* ---------------- 持久化与恢复 ---------------- */

  private persist(id: string) {
    this.dirtyIds.add(id)
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (!existsSync(this.dir)) return // 目录已被移除（如测试清理）
      const snapshot = [...this.dirtyIds]
      this.dirtyIds.clear()
      for (const id of snapshot) {
        const t = this.tasks.get(id)
        if (!t) continue
        try {
          writeFileSync(join(this.dir, `task-${id}.json`), JSON.stringify(t))
        } catch (e) {
          console.error('[task] 持久化失败:', e)
        }
      }
    }, PERSIST_DEBOUNCE_MS)
  }

  private recover() {
    if (!existsSync(this.dir)) return
    const files = readdirSync(this.dir).filter((f) => f.startsWith('task-') && f.endsWith('.json'))
    for (const f of files) {
      try {
        const t = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as ConvertTask
        if (t.status === 'queued' || t.status === 'retrying') {
          // 排队任务：重启后重新执行
          t.status = 'queued'
          t.token++
          this.tasks.set(t.id, t)
          queueMicrotask(() => this.run(t.id, t.token))
        } else if (t.status === 'processing') {
          // 执行中被进程重启打断：标记失败，等待用户手动重试
          t.status = 'failed'
          t.error = '服务器重启，任务中断，可手动重试'
          t.finishedAt = Date.now()
          this.tasks.set(t.id, t)
        } else {
          this.tasks.set(t.id, t)
        }
      } catch {
        // 跳过损坏文件
      }
    }
  }
}

/** 避免在热点路径引入静态 import 命名冲突的小封装 */

export class TaskHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TaskHttpError'
  }
}
