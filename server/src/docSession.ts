import {
  apply,
  baseLength,
  diffToOp,
  isNoop,
  mapPosition,
  transform,
  type Op,
} from '../../shared/ot'
import type { Annotation, LogEntry, Role, UserInfo } from '../../shared/protocol'
import { canAnnotate, canEdit } from '../../shared/protocol'

/** 服务端操作日志保留长度：超出后落后太多的客户端只能走全量快照回滚 */
export const LOG_LIMIT = 1000
/** 历史版本快照周期（修订号）；导出历史版本依赖这些快照 */
export const SNAPSHOT_INTERVAL = 50
/** 周期性正文快照保留份数（另始终保留日志截断锚点） */
export const SNAPSHOT_KEEP = 12

/** 历史版本快照点 */
export interface RevisionSnapshot {
  revision: number
  text: string
  annCount: number
}

export interface ExternalIdentity {
  clientId: string
  name: string
  role: Role
}

export type SubmitError = {
  code: 'PERMISSION_DENIED' | 'BAD_REVISION' | 'RESYNC_REQUIRED'
  message: string
}

const COLORS = [
  '#f56c6c',
  '#e6a23c',
  '#67c23a',
  '#409eff',
  '#9b59b6',
  '#16a085',
  '#d35400',
  '#2c3e50',
]

export interface ClientState {
  clientId: string
  name: string
  role: Role
  color: string
  cursor: { start: number; end: number } | null
  send: (msg: object) => void
}

export class DocSession {
  readonly docId: string
  doc: string
  revision = 0
  /** 广播序号：客户端用它检测消息丢失（cursor/presence 等易失消息不计入） */
  seq = 0
  log: LogEntry[] = []
  annotations = new Map<string, Annotation>()
  clients = new Map<string, ClientState>()
  /** 已接受的 opId 集合（幂等去重：ack 丢失导致客户端重发时不重复应用） */
  private acceptedOpIds = new Set<string>()
  private acceptedOpIdQueue: string[] = []
  private colorIdx = 0
  /**
   * 历史版本正文快照：revision → 该版本的正文。
   * 每 SNAPSHOT_INTERVAL 个修订落一份，日志成批截断时补一份「地板快照」，
   * 早于最早快照的修订无法导出（接口层返回 404）。
   */
  private snapshots = new Map<number, string>()
  /** 当前日志截断地板修订（随截断前移）；null 表示日志尚未截断过 */
  private floorRev: number | null = null
  /** 数据变更回调（用于持久化防抖） */
  onDirty: (() => void) | null = null

  constructor(docId: string, initialDoc = '') {
    this.docId = docId
    this.doc = initialDoc
    this.snapshots.set(0, initialDoc)
  }

  private dirty() {
    this.onDirty?.()
  }

  addClient(clientId: string, name: string, role: Role, send: (msg: object) => void): ClientState {
    const state: ClientState = {
      clientId,
      name: name.slice(0, 24) || '匿名',
      role,
      color: COLORS[this.colorIdx++ % COLORS.length],
      cursor: null,
      send,
    }
    this.clients.set(clientId, state)
    return state
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId)
  }

  users(): UserInfo[] {
    return [...this.clients.values()].map((c) => ({
      clientId: c.clientId,
      name: c.name,
      role: c.role,
      color: c.color,
    }))
  }

  /** 向除 exclude 外的所有客户端广播 */
  broadcast(msg: object, exclude?: string) {
    for (const c of this.clients.values()) {
      if (c.clientId === exclude) continue
      c.send(msg)
    }
  }

  broadcastAll(msg: object) {
    this.broadcast(msg)
  }

  /**
   * 处理客户端提交的编辑操作。
   * 返回 null 表示成功；否则返回错误码与信息。
   */
  receiveOp(
    client: ClientState,
    revision: number,
    op: Op,
    opId: string,
  ): SubmitError | null {
    if (!canEdit(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无编辑权限' }
    }
    // 幂等：该操作已被接受过（ack 丢失后客户端重发）→ 直接重新确认，不重复应用
    if (this.acceptedOpIds.has(opId)) {
      client.send({ type: 'ack', opId, revision: this.revision, seq: this.seq })
      return null
    }
    const err = this.validateOp(revision, op)
    if (err) return err

    // 针对客户端落后期间已被接受的并发操作逐个做 OT 变换
    let transformed = op
    for (let i = this.log.length - (this.revision - revision); i < this.log.length; i++) {
      transformed = transform(transformed, this.log[i].op)
    }

    const entry = this.commitOp(transformed, opId, client.clientId, client.name)
    // 先确认发起者，再广播给其他人（ack 与广播共用同一 seq，保证序号流一致）
    client.send({ type: 'ack', opId, revision: this.revision, seq: this.seq })
    this.broadcast(
      {
        type: 'op',
        revision: entry.revision,
        op: transformed,
        opId,
        clientId: client.clientId,
        authorName: client.name,
        seq: this.seq,
      },
      client.clientId,
    )
    return null
  }

  /** 校验操作基准版本与长度 */
  private validateOp(revision: number, op: Op): SubmitError | null {
    if (typeof revision !== 'number' || revision > this.revision || revision < 0) {
      return { code: 'RESYNC_REQUIRED', message: '版本号异常，请重新同步' }
    }
    const backlog = this.revision - revision
    if (backlog > this.log.length) {
      // 客户端落后太多，日志已不足以做变换，只能全量重同步
      return { code: 'RESYNC_REQUIRED', message: '本地版本过旧，需要全量重同步' }
    }
    // 校验操作基准长度与该版本文档长度一致
    const lenAt = backlog === 0 ? this.doc.length : this.log[this.log.length - backlog].lenBefore
    if (baseLength(op) !== lenAt) {
      return { code: 'BAD_REVISION', message: '操作与基准版本不匹配' }
    }
    return null
  }

  /**
   * 提交一条已变换完成的操作（内部公共路径）：应用、移动批注锚点、写日志、
   * 更新版本/序号、周期性快照，返回日志条目。不负责发送消息。
   */
  private commitOp(op: Op, opId: string, clientId: string, authorName: string): LogEntry {
    const entry: LogEntry = {
      revision: this.revision,
      op,
      opId,
      clientId,
      authorName,
      lenBefore: this.doc.length,
    }
    if (!isNoop(op)) {
      this.doc = apply(this.doc, op)
      this.transformAnnotations(op)
    }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT) {
      const overflow = this.log.length - LOG_LIMIT
      // 截断前先落地板快照：新最早日志条目对应的修订（旧日志仍完整，可直接重建）
      const floorRevision = this.log[overflow].revision
      const text = this.textAt(floorRevision) ?? this.doc
      if (this.floorRev !== null) this.snapshots.delete(this.floorRev)
      this.snapshots.set(floorRevision, text)
      this.floorRev = floorRevision
      this.log.splice(0, overflow)
    }
    this.acceptedOpIds.add(opId)
    this.acceptedOpIdQueue.push(opId)
    if (this.acceptedOpIdQueue.length > LOG_LIMIT * 2) {
      this.acceptedOpIds.delete(this.acceptedOpIdQueue.shift()!)
    }
    this.revision++
    this.seq++

    if (this.revision % SNAPSHOT_INTERVAL === 0) {
      this.snapshots.set(this.revision, this.doc)
      this.pruneSnapshots()
    }
    return entry
  }

  /** 快照保留策略：地板以下快照全部失效；周期快照留最近 SNAPSHOT_KEEP 份 */
  private pruneSnapshots() {
    const revs = [...this.snapshots.keys()].sort((a, b) => a - b)
    const floor = this.floorRev ?? revs[0]
    const valid = revs.filter((r) => r >= floor)
    if (valid.length <= SNAPSHOT_KEEP + 1) {
      // 仍需清理地板以下的残留
      for (const r of revs) if (r < floor) this.snapshots.delete(r)
      return
    }
    // floor 必留，其余取最近 SNAPSHOT_KEEP 份
    const periodics = valid.filter((r) => r !== floor).slice(-SNAPSHOT_KEEP)
    const keep = new Set([floor, ...periodics])
    for (const r of revs) if (!keep.has(r)) this.snapshots.delete(r)
  }

  /**
   * 重建指定修订号的正文；无法覆盖（早于最早快照）时返回 null。
   * 算法：找到 <= revision 的最近快照，重放其后的日志操作。
   */
  textAt(revision: number): string | null {
    if (revision === this.revision) return this.doc
    if (revision < 0 || revision > this.revision) return null
    // 早于日志截断地板的修订：对应操作已永久丢弃，无法重建
    if (this.floorRev !== null && revision < this.floorRev) return null
    let baseRev = -1
    for (const r of this.snapshots.keys()) {
      if (r <= revision && r > baseRev) baseRev = r
    }
    if (baseRev < 0) return null
    let text = this.snapshots.get(baseRev)!
    for (const e of this.log) {
      if (e.revision < baseRev) continue
      if (e.revision >= revision) break
      text = apply(text, e.op)
    }
    return text
  }

  /**
   * 可导出的历史版本点（修订号、字符数），含当前版本。
   * 日志覆盖范围内的任意修订正文都可由「地板快照 + 日志重放」重建；
   * 点过多时等距抽样到最多 HISTORY_POINTS_MAX 个（当前版本始终保留）。
   */
  historyPoints(): { revision: number; chars: number }[] {
    const minRev = this.floorRev ?? (this.snapshots.has(0) ? 0 : this.revision)
    const span = this.revision - minRev
    if (span === 0) return [{ revision: this.revision, chars: this.doc.length }]

    // 单次前向重放，记录每个修订的字符数
    const base = this.snapshots.get(minRev)
    const lengths = new Map<number, number>()
    if (base !== undefined) {
      let text = base
      lengths.set(minRev, text.length)
      for (const e of this.log) {
        if (e.revision < minRev) continue
        text = apply(text, e.op)
        lengths.set(e.revision + 1, text.length)
      }
    }
    lengths.set(this.revision, this.doc.length)

    const revs: number[] = []
    const MAX = 60
    if (span <= MAX) {
      for (let r = minRev; r <= this.revision; r++) revs.push(r)
    } else {
      const step = span / MAX
      for (let k = 0; k < MAX; k++) revs.push(Math.min(this.revision, minRev + Math.round(k * step)))
      revs.push(this.revision)
    }
    const uniq = [...new Set(revs)].sort((a, b) => b - a)
    return uniq.map((revision) => ({
      revision,
      chars: lengths.get(revision) ?? (revision === this.revision ? this.doc.length : 0),
    }))
  }

  /**
   * 外部协同变更（导入确认）：以「目标全文」生成 op，复用 OT 提交流程，
   * 像普通编辑一样向所有在线协作者广播。返回提交结果或错误。
   */
  submitExternalChange(
    identity: ExternalIdentity,
    newText: string,
  ): { op: Op; baseRevision: number; revision: number; doc: string } | SubmitError {
    if (!canEdit(identity.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无编辑权限，无法确认导入' }
    }
    const baseRevision = this.revision
    const op = diffToOp(this.doc, newText)
    if (isNoop(op)) {
      return { op, baseRevision, revision: this.revision, doc: this.doc }
    }
    const opId = `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const entry = this.commitOp(op, opId, identity.clientId, identity.name)
    this.broadcastAll({
      type: 'op',
      revision: entry.revision,
      op,
      opId,
      clientId: identity.clientId,
      authorName: `${identity.name}（导入）`,
      seq: this.seq,
    })
    this.dirty()
    return { op, baseRevision, revision: this.revision, doc: this.doc }
  }

  /** 某修订号下的批注快照（批注不做历史版本，导出历史版本时仅导出正文） */
  annotationsAt(_revision: number): Annotation[] {
    return [...this.annotations.values()]
  }

  /** 编辑操作后，批注锚点随文档做位置映射 */
  private transformAnnotations(op: Op) {
    for (const ann of this.annotations.values()) {
      ann.start = mapPosition(ann.start, op, 'after')
      ann.end = mapPosition(ann.end, op, 'before')
      if (ann.end < ann.start) ann.end = ann.start
      ann.orphan = ann.start === ann.end
    }
  }

  addAnnotation(
    client: ClientState,
    msg: { annId: string; start: number; end: number; quote: string; text: string },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const start = Math.max(0, Math.min(msg.start, this.doc.length))
    const end = Math.max(start, Math.min(msg.end, this.doc.length))
    if (!msg.text || !msg.text.trim()) {
      return { code: 'BAD_MESSAGE', message: '批注内容不能为空' }
    }
    const ann: Annotation = {
      id: msg.annId,
      start,
      end,
      orphan: start === end,
      quote: (msg.quote || this.doc.slice(start, end)).slice(0, 200),
      authorId: client.clientId,
      authorName: client.name,
      text: msg.text.trim().slice(0, 2000),
      replies: [],
      resolved: false,
      createdAt: Date.now(),
    }
    this.annotations.set(ann.id, ann)
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
    return null
  }

  replyAnnotation(
    client: ClientState,
    msg: { annId: string; replyId: string; text: string },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const ann = this.annotations.get(msg.annId)
    if (!ann || !msg.text?.trim()) {
      return { code: 'BAD_MESSAGE', message: '批注不存在或内容为空' }
    }
    ann.replies.push({
      id: msg.replyId,
      authorId: client.clientId,
      authorName: client.name,
      text: msg.text.trim().slice(0, 2000),
      createdAt: Date.now(),
    })
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
    return null
  }

  resolveAnnotation(
    client: ClientState,
    msg: { annId: string; resolved: boolean },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const ann = this.annotations.get(msg.annId)
    if (!ann) return { code: 'BAD_MESSAGE', message: '批注不存在' }
    ann.resolved = !!msg.resolved
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
    return null
  }

  deleteAnnotation(
    client: ClientState,
    annId: string,
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    const ann = this.annotations.get(annId)
    if (!ann) return { code: 'BAD_MESSAGE', message: '批注不存在' }
    // 仅作者本人或编辑者可删除
    if (ann.authorId !== client.clientId && !canEdit(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '仅作者或编辑者可删除批注' }
    }
    this.annotations.delete(annId)
    this.seq++
    this.broadcastAll({ type: 'ann:delete', annId, seq: this.seq })
    this.dirty()
    return null
  }

  updateCursor(client: ClientState, start: number, end: number) {
    client.cursor = { start, end }
    // 光标消息易失：不计 seq、不持久化，直接转发
    this.broadcast({ type: 'cursor', clientId: client.clientId, start, end }, client.clientId)
  }

  /**
   * 断线重连：优先按版本号增量补齐错过的操作；日志不足时回退全量快照。
   */
  buildResync(lastRevision: number):
    | { kind: 'ops'; ops: LogEntry[] }
    | { kind: 'snapshot' } {
    const backlog = this.revision - lastRevision
    if (backlog >= 0 && backlog <= this.log.length) {
      return { kind: 'ops', ops: this.log.slice(this.log.length - backlog) }
    }
    return { kind: 'snapshot' }
  }

  /** 序列化快照（持久化用） */
  serialize() {
    return {
      docId: this.docId,
      doc: this.doc,
      revision: this.revision,
      annotations: [...this.annotations.values()],
    }
  }

  static deserialize(data: {
    docId: string
    doc: string
    revision: number
    annotations: Annotation[]
  }): DocSession {
    const s = new DocSession(data.docId, data.doc)
    s.revision = data.revision || 0
    // 重启后内存日志为空：仅当前修订可导出，历史版本需重新积累快照
    s.snapshots.clear()
    s.snapshots.set(s.revision, data.doc)
    for (const a of data.annotations || []) s.annotations.set(a.id, a)
    return s
  }
}
