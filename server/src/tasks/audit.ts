/**
 * 操作审计日志：JSONL 追加写（audit-YYYY-MM.jsonl 按月滚动），
 * 读取时合并近月文件。转换中心的每个敏感动作（提交/确认/取消/重试/失败/下载）均落盘。
 */
import { existsSync, mkdirSync, createReadStream, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { AuditEntry } from '../../../shared/transfer'

const MAX_READ = 5000

export class AuditLog {
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private fileFor(ts: number): string {
    const d = new Date(ts)
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return join(this.dir, `audit-${month}.jsonl`)
  }

  append(entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): AuditEntry {
    const full: AuditEntry = {
      id: `a-${randomUUID().slice(0, 12)}`,
      at: entry.at ?? Date.now(),
      docId: entry.docId,
      action: entry.action,
      actor: entry.actor,
      role: entry.role,
      taskId: entry.taskId,
      kind: entry.kind,
      format: entry.format,
      variant: entry.variant,
      revision: entry.revision,
      newRevision: entry.newRevision,
      detail: entry.detail,
      status: entry.status,
    }
    appendFileSync(this.fileFor(full.at), JSON.stringify(full) + '\n')
    return full
  }

  /** 读取审计记录（默认仅当前文档），按时间倒序，流式解析避免整文件入内存 */
  async read(docId?: string, limit = 200): Promise<AuditEntry[]> {
    const files = readdirSync(this.dir)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, 2)
      .map((f) => join(this.dir, f))

    const entries: AuditEntry[] = []
    outer: for (const file of files) {
      const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
      const batch: AuditEntry[] = []
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as AuditEntry
          if (docId && e.docId !== docId) continue
          batch.push(e)
        } catch {
          /* 跳过损坏行 */
        }
        if (batch.length >= MAX_READ) break outer
      }
      // 单文件内追加顺序为时间升序，倒序后拼接
      entries.push(...batch.reverse())
      if (entries.length >= MAX_READ) break
    }
    entries.sort((a, b) => b.at - a.at)
    return entries.slice(0, limit)
  }
}
