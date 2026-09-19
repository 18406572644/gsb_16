/**
 * 转换操作审计：JSONL 追加写（每次操作一行），启动时按文件倒序读取最近记录。
 * 审计为旁路能力：写入失败仅打印告警，绝不阻断主流程。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuditAction, AuditRecord } from '../../../shared/convert'

export type AuditInput = Omit<AuditRecord, 'id' | 'ts'> & { ts?: number }

export class AuditLog {
  private file: string
  /** 内存缓存（倒序，最新在前），仅缓存最近 MAX_CACHE 条 */
  private recent: AuditRecord[] = []
  private readonly MAX_CACHE = 2000

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'convert-audit.jsonl')
    this.load()
  }

  private load() {
    if (!existsSync(this.file)) return
    try {
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
      const records: AuditRecord[] = []
      for (const line of lines) {
        try {
          records.push(JSON.parse(line))
        } catch {
          // 跳过损坏行
        }
      }
      this.recent = records.slice(-this.MAX_CACHE).reverse()
    } catch (e) {
      console.error('[audit] 读取审计日志失败:', e)
    }
  }

  record(input: AuditInput): AuditRecord {
    const rec: AuditRecord = {
      id: randomUUID(),
      ts: input.ts ?? Date.now(),
      action: input.action,
      docId: input.docId,
      actor: input.actor,
      taskId: input.taskId,
      detail: input.detail,
      ok: input.ok,
      error: input.error,
    }
    try {
      appendFileSync(this.file, JSON.stringify(rec) + '\n')
    } catch (e) {
      console.error('[audit] 写入失败:', e)
    }
    this.recent.unshift(rec)
    if (this.recent.length > this.MAX_CACHE) this.recent.length = this.MAX_CACHE
    return rec
  }

  /** 查询：按 docId/action/actor 过滤，倒序（最新在前），limit 分页 */
  list(filter: { docId?: string; action?: AuditAction; actor?: string; limit?: number; beforeTs?: number } = {}): AuditRecord[] {
    let rows = this.recent
    if (filter.docId) rows = rows.filter((r) => r.docId === filter.docId)
    if (filter.action) rows = rows.filter((r) => r.action === filter.action)
    if (filter.actor) rows = rows.filter((r) => r.actor === filter.actor)
    if (filter.beforeTs) rows = rows.filter((r) => r.ts < filter.beforeTs!)
    const limit = Math.min(filter.limit ?? 100, 500)
    return rows.slice(0, limit)
  }
}
