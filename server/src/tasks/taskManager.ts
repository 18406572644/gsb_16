/**
 * 异步转换任务中心。
 *
 * 职责：
 * - 任务排队与并发执行（全局并发闸，长耗时转换不阻塞协作链路）；
 * - 状态机：pending → running →（retrying → running …）→ succeeded/failed/canceled；
 * - 失败重试：确定性错误（FatalConvertError）不重试；瞬时错误指数退避自动重试，
 *   达到上限后置 failed，用户仍可手动 retry（重置计数）；
 * - 协作式取消：排队/等待重试中的任务立即取消；执行中的任务通过 CancelToken 轮询；
 * - 执行超时：TASK_LIMITS.runTimeoutMs，超时按可重试错误处理；
 * - 持久化：tasks.json 防抖落盘；服务重启后导出任务自动重排队，导入任务因源文件
 *   仅存内存而置失败（提示重新上传）；
 * - 产物：导出文件写 artifacts/<taskId>，TTL 到期置 expired 并删文件；记录保留 24h；
 * - 审计：状态终态/重试/取消通过 onAudit 回调交给审计日志。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  TASK_LIMITS,
  type AuditAction,
  type AuditEntry,
  type ConvertTask,
  type DocFormat,
  type ExportVariant,
  type TaskKind,
  type TaskProgress,
} from '../../../shared/transfer'
import { CanceledError, FatalConvertError } from './errors'

export interface CancelToken {
  readonly canceled: boolean
  /** 取消点：若已取消则抛 CanceledError（长任务在阶段/分块间调用） */
  check(): void
}

export interface RunContext {
  task: ConvertTask
  token: CancelToken
  report: (phase: string, percent: number) => void
  checkCanceled: () => void
}

export interface TaskManagerServices {
  runImport: (task: ConvertTask, payload: Buffer, ctx: RunContext) => Promise<void>
  runExport: (task: ConvertTask, ctx: RunContext) => Promise<void>
  onAudit: (entry: Omit<AuditEntry, 'id' | 'at'>) => void
}

interface CreateParams {
  kind: TaskKind
  format: DocFormat
  docId: string
  ownerName: string
  ownerRole: ConvertTask['ownerRole']
  sourceName: string
  sourceSize: number
  variant?: ExportVariant
  revision?: number
}

const TICK_MS = 200
const PERSIST_DEBOUNCE_MS = 1000

export class TaskManager {
  private tasks = new Map<string, ConvertTask>()
  private payloads = new Map<string, Buffer>()
  private tokens = new Map<string, { canceled: boolean }>()
  private timers = new Map<string, NodeJS.Timeout>()
  private persistTimer: NodeJS.Timeout | null = null
  private ticker: NodeJS.Timeout | null = null
  private sweeper: NodeJS.Timeout | null = null
  private running = 0
  private started = false

  constructor(
    private dir: string,
    private services: TaskManagerServices,
    private concurrency = 2,
  ) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.restore()
  }

  private get tasksFile() {
    return join(this.dir, 'tasks.json')
  }
  artifactPath(taskId: string) {
    return join(this.dir, 'artifacts', `${taskId}.bin`)
  }

  /* ---------------- 生命周期 ---------------- */

  start() {
    if (this.started) return
    this.started = true
    this.ticker = setInterval(() => this.tick(), TICK_MS)
    // 每 60s 做一次 TTL 清理
    this.sweeper = setInterval(() => this.sweep(), 60_000)
  }

  shutdown() {
    if (this.ticker) clearInterval(this.ticker)
    if (this.sweeper) clearInterval(this.sweeper)
    for (const t of this.timers.values()) clearTimeout(t)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistNow()
  }

  /* ---------------- 查询 ---------------- */

  list(docId?: string): ConvertTask[] {
    const all = [...this.tasks.values()].filter((t) => !docId || t.docId === docId)
    return all.sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): ConvertTask | undefined {
    return this.tasks.get(id)
  }

  /* ---------------- 创建 ---------------- */

  createTask(params: CreateParams, payload?: Buffer): ConvertTask {
    const now = Date.now()
    const task: ConvertTask = {
      id: `t-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      kind: params.kind,
      format: params.format,
      status: 'pending',
      docId: params.docId,
      ownerName: params.ownerName,
      ownerRole: params.ownerRole,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      progress: { phase: '排队中', percent: 0 },
      attempts: 0,
      maxAttempts: TASK_LIMITS.maxAttempts,
      nextRetryAt: null,
      error: null,
      history: [],
      sourceName: params.sourceName,
      sourceSize: params.sourceSize,
      variant: params.variant,
      revision: params.revision,
    }
    this.tasks.set(task.id, task)
    if (payload) this.payloads.set(task.id, payload)
    this.enforcePerDocLimit(params.docId)
    this.prunePayloads()
    this.persist()
    return task
  }

  /** 失败导入的源字节仅保留最近 10 个，超出释放（重试需重新上传） */
  private prunePayloads() {
    if (this.payloads.size <= 10) return
    const recent = new Set(
      [...this.tasks.values()]
        .filter((t) => t.status === 'failed')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10)
        .map((t) => t.id),
    )
    for (const id of [...this.payloads.keys()]) {
      const t = this.tasks.get(id)
      if (t && t.status === 'failed' && !recent.has(id)) this.payloads.delete(id)
    }
  }

  /** 单文档任务数上限：优先淘汰最早的已完成任务（产物一并清理） */
  private enforcePerDocLimit(docId: string) {
    const own = this.list(docId)
    if (own.length <= TASK_LIMITS.perDoc) return
    const removable = own
      .reverse()
      .filter((t) => t.status === 'succeeded' || t.status === 'expired' || t.status === 'failed' || t.status === 'canceled')
    let excess = own.length - TASK_LIMITS.perDoc
    for (const t of removable) {
      if (excess <= 0) break
      this.deleteTask(t.id)
      excess--
    }
  }

  private deleteTask(id: string) {
    const t = this.tasks.get(id)
    if (!t) return
    this.tasks.delete(id)
    this.payloads.delete(id)
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.removeArtifact(id)
    void t
  }

  private removeArtifact(id: string) {
    try {
      if (existsSync(this.artifactPath(id))) unlinkSync(this.artifactPath(id))
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 取消 / 重试 ---------------- */

  cancel(id: string): { ok: true } | { ok: false; message: string } {
    const t = this.tasks.get(id)
    if (!t) return { ok: false, message: '任务不存在' }
    if (t.status === 'succeeded' || t.status === 'failed' || t.status === 'canceled' || t.status === 'expired') {
      return { ok: false, message: `任务已结束（${t.status}），无法取消` }
    }
    if (t.status === 'running') {
      // 协作式：通知执行体在下一个取消点停止
      const token = this.tokens.get(id)
      if (token) token.canceled = true
      t.progress = { phase: '正在取消…', percent: t.progress.percent }
      t.updatedAt = Date.now()
      // 兜底：3s 内未停下则强制终结
      const timer = setTimeout(() => {
        if (this.tasks.get(id)?.status === 'running') this.finishCanceled(t)
      }, 3000)
      this.timers.set(`cancel-${id}`, timer)
      this.persist()
      return { ok: true }
    }
    // pending / retrying：立即终结
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.finishCanceled(t)
    return { ok: true }
  }

  private finishCanceled(t: ConvertTask) {
    t.status = 'canceled'
    t.finishedAt = Date.now()
    t.nextRetryAt = null
    t.progress = { phase: '已取消', percent: 100 }
    t.updatedAt = Date.now()
    this.tokens.delete(t.id)
    this.payloads.delete(t.id)
    const ct = this.timers.get(`cancel-${t.id}`)
    if (ct) {
      clearTimeout(ct)
      this.timers.delete(`cancel-${t.id}`)
    }
    this.persist()
  }

  /** 手动重试：重置尝试计数重新排队（失败终态/过期任务可用） */
  retry(id: string): { ok: true; task: ConvertTask } | { ok: false; message: string } {
    const t = this.tasks.get(id)
    if (!t) return { ok: false, message: '任务不存在' }
    if (t.status === 'pending' || t.status === 'running' || t.status === 'retrying') {
      return { ok: false, message: '任务尚未结束，无需重试' }
    }
    if (t.kind === 'import' && !this.payloads.has(t.id)) {
      // 重启后导入源文件已不在内存，无法重试
      return { ok: false, message: '源文件已随服务重启释放，请重新上传' }
    }
    t.status = 'pending'
    t.error = null
    t.history = []
    t.attempts = 0
    t.finishedAt = null
    t.startedAt = null
    t.nextRetryAt = null
    t.progress = { phase: '重新排队', percent: 0 }
    t.updatedAt = Date.now()
    if (t.kind === 'export') t.result = undefined
    this.persist()
    return { ok: true, task: t }
  }

  /* ---------------- 调度 ---------------- */

  private tick() {
    const now = Date.now()
    // retrying 到期 → 回到 pending
    for (const t of this.tasks.values()) {
      if (t.status === 'retrying' && t.nextRetryAt !== null && t.nextRetryAt <= now) {
        t.status = 'pending'
        t.nextRetryAt = null
        t.updatedAt = now
      }
    }
    if (this.running >= this.concurrency) return
    for (const t of this.tasks.values()) {
      if (this.running >= this.concurrency) break
      if (t.status !== 'pending') continue
      // 导入任务若源负载缺失（重启恢复场景），直接失败
      if (t.kind === 'import' && !this.payloads.has(t.id)) {
        t.status = 'failed'
        t.error = { message: '源文件已随服务重启释放，请重新上传', at: Date.now() }
        t.finishedAt = Date.now()
        continue
      }
      void this.run(t)
    }
  }

  private async run(task: ConvertTask) {
    this.running++
    task.status = 'running'
    task.attempts++
    task.startedAt ??= Date.now()
    task.updatedAt = Date.now()
    task.progress = { phase: task.kind === 'import' ? '读取与解析文件…' : '准备导出数据…', percent: 5 }

    const tokenState = { canceled: false }
    this.tokens.set(task.id, tokenState)
    const token: CancelToken = {
      get canceled() {
        return tokenState.canceled
      },
      check() {
        if (tokenState.canceled) throw new CanceledError()
      },
    }
    const ctx: RunContext = {
      task,
      token,
      checkCanceled: () => token.check(),
      report: (phase, percent) => {
        task.progress = { phase, percent: Math.max(task.progress.percent, Math.min(99, percent)) }
        task.updatedAt = Date.now()
      },
    }

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`转换超时（${TASK_LIMITS.runTimeoutMs / 1000}s）`)), TASK_LIMITS.runTimeoutMs)
    })
    // race 结束后超时拒绝仍可能落地，吞掉未被消费的 rejection（timer 在 finally 中清理）
    timeout.catch(() => {})

    try {
      const payload = this.payloads.get(task.id)
      const work =
        task.kind === 'import'
          ? this.services.runImport(task, payload!, ctx)
          : this.services.runExport(task, ctx)
      await Promise.race([work, timeout])
      if (token.canceled) throw new CanceledError()

      task.status = 'succeeded'
      task.progress = { phase: '完成', percent: 100 }
      task.finishedAt = Date.now()
      task.error = null
      task.nextRetryAt = null
      this.payloads.delete(task.id) // 导入成功后源字节不再保留
    } catch (e) {
      if (e instanceof CanceledError || token.canceled) {
        this.finishCanceled(task)
      } else if (e instanceof FatalConvertError) {
        this.finishFailed(task, e, true)
      } else {
        this.scheduleRetryOrFail(task, e)
      }
    } finally {
      if (timer) clearTimeout(timer)
      this.tokens.delete(task.id)
      this.running--
      task.updatedAt = Date.now()
      this.persist()
    }
  }

  private scheduleRetryOrFail(task: ConvertTask, e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    task.history.push({ message, at: Date.now() })
    if (task.attempts >= task.maxAttempts) {
      this.finishFailed(task, e, false)
      return
    }
    const backoff = task.attempts * task.attempts * TASK_LIMITS.retryBaseMs
    task.status = 'retrying'
    task.error = { message, at: Date.now() }
    task.nextRetryAt = Date.now() + backoff
    task.progress = { phase: `第 ${task.attempts} 次失败，${Math.round(backoff / 1000)}s 后自动重试`, percent: task.progress.percent }
    task.updatedAt = Date.now()
    this.audit('task.fail', task, task.ownerName, 'error', message)
  }

  private finishFailed(task: ConvertTask, e: unknown, fatal: boolean) {
    const message = e instanceof Error ? e.message : String(e)
    task.status = 'failed'
    task.error = {
      message,
      code: e instanceof FatalConvertError ? e.code : fatal ? 'CONVERT_FAILED' : 'RETRIES_EXHAUSTED',
      at: Date.now(),
    }
    task.finishedAt = Date.now()
    task.nextRetryAt = null
    task.progress = { phase: '失败', percent: 100 }
    task.updatedAt = Date.now()
    // 保留导入源负载以便同进程内手动重试（重启后由 restore 判定失败）
    this.audit('task.fail', task, task.ownerName, 'error', fatal ? message : `自动重试已耗尽：${message}`)
  }

  /* ---------------- 产物 ---------------- */

  writeArtifact(id: string, data: Buffer) {
    const dir = join(this.dir, 'artifacts')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.artifactPath(id), data)
  }

  readArtifact(id: string): Buffer | null {
    try {
      const p = this.artifactPath(id)
      return existsSync(p) ? readFileSync(p) : null
    } catch {
      return null
    }
  }

  /** TTL 清理：过期产物 → expired；过期记录整体删除 */
  private sweep() {
    const now = Date.now()
    for (const t of [...this.tasks.values()]) {
      if (t.status === 'succeeded' && t.result && t.finishedAt) {
        if (now - t.finishedAt > TASK_LIMITS.artifactTtlMs) {
          this.removeArtifact(t.id)
          t.result = undefined
          t.status = 'expired'
          t.updatedAt = now
        }
      }
      if (now - t.createdAt > TASK_LIMITS.recordTtlMs) {
        this.deleteTask(t.id)
      }
    }
    this.persist()
  }

  /* ---------------- 审计 ---------------- */

  private audit(
    action: AuditAction,
    t: ConvertTask,
    actor: string,
    status: AuditEntry['status'],
    detail?: string,
  ) {
    this.services.onAudit({
      docId: t.docId,
      action,
      actor,
      role: t.ownerRole,
      taskId: t.id,
      kind: t.kind,
      format: t.format,
      variant: t.variant,
      revision: t.revision,
      detail,
      status,
    })
  }

  /* ---------------- 持久化 ---------------- */

  private persist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  private persistNow() {
    try {
      const data = [...this.tasks.values()]
      writeFileSync(this.tasksFile, JSON.stringify(data))
    } catch (e) {
      console.error('[tasks] 持久化失败:', e)
    }
  }

  private restore() {
    if (!existsSync(this.tasksFile)) return
    try {
      const data = JSON.parse(readFileSync(this.tasksFile, 'utf8')) as ConvertTask[]
      const now = Date.now()
      for (const t of data) {
        // 重启恢复：执行态任务收敛到确定状态
        if (t.status === 'running' || t.status === 'pending' || t.status === 'retrying') {
          if (t.kind === 'export') {
            // 导出不依赖上传负载，重新排队自动续跑
            t.status = 'pending'
            t.nextRetryAt = null
            t.progress = { phase: '服务重启后重新排队', percent: 0 }
            if (t.result) {
              // 旧产物视为失效
              t.result = undefined
              this.removeArtifact(t.id)
            }
          } else {
            t.status = 'failed'
            t.error = { message: '服务重启导致任务中断，源文件需重新上传', at: now }
            t.finishedAt = now
            t.nextRetryAt = null
          }
        }
        // 已过期产物文件在 sweep 中对账
        if (t.status === 'succeeded' && t.kind === 'export' && t.result) {
          if (!existsSync(this.artifactPath(t.id))) t.result = undefined
        }
        this.tasks.set(t.id, t)
      }
      console.log(`[tasks] 恢复 ${data.length} 个转换任务记录`)
    } catch (e) {
      console.error('[tasks] 恢复失败:', e)
    }
  }

  /** 调试/信息用：artifacts 目录条目数 */
  artifactCount(): number {
    const dir = join(this.dir, 'artifacts')
    if (!existsSync(dir)) return 0
    return readdirSync(dir).length
  }

  /** 进度快照（轮询接口用） */
  progressOf(id: string): TaskProgress | null {
    return this.tasks.get(id)?.progress ?? null
  }
}
