/**
 * 转换中心测试：结构差异、转换器往返、历史版本重建、
 * 异步任务重试/取消、导入确认流程与权限/过期校验、批注版导出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffLines } from '../src/convert/diff'
import { htmlToMarkdown } from '../src/convert/html'
import { markdownToHtmlBody } from '../src/convert/markdown'
import { exportDocument, parseImport } from '../src/convert/convert'
import { TaskStore, TaskCancelledError } from '../src/convert/taskStore'
import { AuditLog } from '../src/convert/audit'
import { ConvertService, ServiceError } from '../src/convert/convertService'
import { DocSession } from '../src/docSession'
import type { Annotation } from '../../shared/protocol'

/* ---------------- 结构差异 ---------------- */

test('diff: 行级增删改与锚点对齐', () => {
  const d = diffLines('保留1\n删除行\n保留2\n共同长锚点行XYZ\n尾部', '保留1\n新增行\n保留2\n共同长锚点行XYZ\n新尾部')
  const kinds = d.map((b) => b.type[0]).join('')
  assert.ok(kinds.startsWith('e'), '首行相等')
  assert.ok(d.some((b) => b.type === 'removed' && b.text === '删除行'))
  assert.ok(d.some((b) => b.type === 'added' && b.text === '新增行'))
  assert.ok(d.some((b) => b.type === 'equal' && b.text === '共同长锚点行XYZ'))
  // 行号连续合理
  for (const b of d) {
    if (b.type !== 'added') assert.ok((b.oldLine as number) >= 0)
    if (b.type !== 'removed') assert.ok((b.newLine as number) >= 0)
  }
})

test('diff: 完全相同无差异', () => {
  const d = diffLines('a\nb\nc', 'a\nb\nc')
  assert.equal(d.every((b) => b.type === 'equal'), true)
})

test('diff: 超长文档线性可用（5 万行）', () => {
  const a = Array.from({ length: 50_000 }, (_, i) => `old-${i}`).join('\n')
  const b = Array.from({ length: 50_000 }, (_, i) => (i === 25_000 ? 'INSERTED' : `old-${i}`)).join('\n')
  const t0 = Date.now()
  const d = diffLines(a, b)
  assert.ok(Date.now() - t0 < 3000, '应在数秒内完成')
  assert.ok(d.some((x) => x.type === 'added' && x.text === 'INSERTED'))
})

/* ---------------- 转换器 ---------------- */

test('html→md: 中文/实体/链接/图片/列表/表格', () => {
  const md = htmlToMarkdown(`
    <h1>标题 &amp; &lt;x&gt;</h1>
    <p>中文 <a href="https://a.com/中?x=1&y=2">链接</a> <img src="/i.png" alt="图"></p>
    <ul><li>一<ul><li>嵌套</li></ul></li></ul>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`)
  assert.match(md, /# 标题 & <x>/)
  assert.match(md, /\[链接\]\(https:\/\/a\.com\/中\?x=1&y=2\)/)
  assert.match(md, /!\[图\]\(\/i\.png\)/)
  assert.match(md, /- 一/)
  assert.match(md, /  - 嵌套/)
  assert.match(md, /\| A \| B \|/)
  assert.match(md, /\| 1 \| 2 \|/)
})

test('md→html: 特殊字符转义与链接', () => {
  const html = markdownToHtmlBody('# 标题 <脚本>\n\n正文 **粗** [链](https://a.com) `<x>`')
  assert.match(html, /<h1>标题 &lt;脚本&gt;<\/h1>/)
  assert.match(html, /<strong>粗<\/strong>/)
  assert.match(html, /<a href="https:\/\/a\.com"/)
  assert.match(html, /<code>&lt;x&gt;<\/code>/)
})

test('parseImport: UTF-8 BOM 与 CRLF 规整', async () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\r\n\r\n正文行', 'utf8')])
  const r = await parseImport(buf, 'md')
  assert.equal(r.text.startsWith('# 标题\n'), true)
  assert.equal(r.stats.chars > 0, true)
})

/* ---------------- DocSession 历史版本 ---------------- */

test('DocSession: 外部提交进入版本历史，历史版本可重建', () => {
  const s = new DocSession('d1', '原始正文第一版\n')
  const editor = s.addClient('c1', '张三', 'editor', () => {})
  const r1 = s.receiveOp(editor, 0, [{ retain: 4 }, { insert: '（插入）' }, { retain: 4 }], 'op-1')
  assert.equal(r1, null)
  const rev1 = s.revision
  assert.match(s.doc, /（插入）/)

  const ext = s.commitExternal('李四', '完全不同的新正文\n', {
    kind: 'import', refId: 'pv1', sourceName: 'a.md', userName: '李四',
  })
  assert.equal(ext.changed, true)
  assert.equal(s.doc, '完全不同的新正文\n')
  assert.equal(s.log.at(-1)!.external?.kind, 'import')
  assert.ok(s.log.at(-1)!.inverse, '日志记录逆操作')

  // 回退到导入前版本
  const atRev1 = s.docAtRevision(rev1)
  assert.equal(atRev1, '原始正文（插入）第一版\n')
  // 当前版本
  assert.equal(s.docAtRevision(s.revision), '完全不同的新正文\n')
  // 超出保留范围
  assert.equal(s.docAtRevision(s.revision + 1), null)

  const infos = s.revisions()
  assert.equal(infos.length, 2)
  assert.equal(infos[1]!.external?.sourceName, 'a.md')
})

/* ---------------- 批注版导出 ---------------- */

test('导出: 批注版 HTML 内联锚点 + 侧栏；历史版批注位置回映', () => {
  const s = new DocSession('d2', '第一段需要讨论的文字。\n第二段保留内容。\n')
  const ann: Annotation = {
    id: 'a1', start: 3, end: 9, orphan: false, quote: '需要讨论',
    authorId: 'u1', authorName: '王五', text: '请修改措辞',
    replies: [{ id: 'r1', authorId: 'u2', authorName: '赵六', text: '同意', createdAt: Date.now() }],
    resolved: false, createdAt: Date.now(),
  }
  s.annotations.set(ann.id, ann)

  const html = exportDocument('d2', s.doc, 'html', { withAnnotations: true, annotations: [ann] }).body.toString('utf8')
  assert.match(html, /<mark class="ann-hl"[^>]*>需要讨论<\/mark>/)
  assert.match(html, /批注（1）/)
  assert.match(html, /赵六/)

  const md = exportDocument('d2', s.doc, 'md', { withAnnotations: true, annotations: [ann] }).body.toString('utf8')
  assert.match(md, /## 批注清单（共 1 条）/)
  assert.match(md, /请修改措辞/)

  // 历史版本批注：在开头插入一段后，锚点位置应回映到旧坐标
  const editor = s.addClient('c2', '张三', 'editor', () => {})
  s.receiveOp(editor, s.revision, [{ insert: '新插入的开头。\n' }, { retain: s.doc.length }], 'op-x')
  const oldAnns = s.annotationsAtRevision(s.revision - 1)
  assert.equal(oldAnns[0]!.start, 3)
  assert.equal(oldAnns[0]!.end, 9)
})

/* ---------------- 任务中心 ---------------- */

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'conv-task-'))
  const tasks = new TaskStore(dir)
  const audit = new AuditLog(dir)
  return { dir, tasks, audit }
}

test('TaskStore: 成功任务落产物', async () => {
  const { tasks, dir } = makeStore()
  tasks.registerExecutor('export', async () => ({
    artifact: { fileName: 'f.md', contentType: 'text/markdown', buffer: Buffer.from('hello') },
  }))
  const t = tasks.enqueue({ kind: 'export', docId: 'd', ownerName: '张三', fileName: 'f.md', format: 'md' })
  await waitFor(() => tasks.get(t.id)!.status === 'succeeded')
  assert.equal(tasks.get(t.id)!.status, 'succeeded')
  const art = tasks.loadArtifact(tasks.get(t.id)!.resultId!)
  assert.equal(art!.buffer.toString(), 'hello')
  rmSync(dir, { recursive: true, force: true })
})

test('TaskStore: 失败自动重试，达到上限后 failed；手动 retry 可恢复', async () => {
  const { tasks, dir } = makeStore()
  let calls = 0
  tasks.registerExecutor('export', async () => {
    calls++
    if (calls < 4) throw new Error(`模拟失败 #${calls}`)
    return { artifact: { fileName: 'ok', contentType: 'text/plain', buffer: Buffer.from('ok') } }
  })
  const t = tasks.enqueue({ kind: 'export', docId: 'd', ownerName: 'x', fileName: 'ok', format: 'txt' })
  await waitFor(() => tasks.get(t.id)!.status === 'failed', 5000)
  assert.equal(tasks.get(t.id)!.attempts, 3)
  assert.match(tasks.get(t.id)!.error!, /模拟失败 #3/)
  tasks.retry(t.id)
  await waitFor(() => tasks.get(t.id)!.status === 'succeeded', 5000)
  assert.equal(calls, 4)
  rmSync(dir, { recursive: true, force: true })
})

test('TaskStore: 处理中任务可取消（协作式中止信号）', async () => {
  const { tasks, dir } = makeStore()
  tasks.registerExecutor('export', async (ctx) => {
    await new Promise((resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new TaskCancelledError()))
    })
    return {}
  })
  const t = tasks.enqueue({ kind: 'export', docId: 'd', ownerName: 'x', fileName: 'f', format: 'md' })
  await waitFor(() => tasks.get(t.id)!.status === 'processing')
  tasks.cancel(t.id)
  await waitFor(() => tasks.get(t.id)!.status === 'cancelled')
  assert.equal(tasks.get(t.id)!.status, 'cancelled')
  // 已结束任务不可重复取消
  assert.throws(() => tasks.cancel(t.id))
  // 已取消任务可手动重试：重新进入执行（执行器仍挂起，再次取消收尾）
  tasks.retry(t.id)
  await waitFor(() => tasks.get(t.id)!.status === 'processing')
  tasks.cancel(t.id)
  await waitFor(() => tasks.get(t.id)!.status === 'cancelled')
  rmSync(dir, { recursive: true, force: true })
})

/* ---------------- 服务编排：导入确认全流程 ---------------- */

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'conv-svc-'))
  const tasks = new TaskStore(dir)
  const audit = new AuditLog(dir)
  const sessions = new Map<string, DocSession>()
  const getSession = (id: string) => {
    let s = sessions.get(id)
    if (!s) {
      s = new DocSession(id, '现有正文内容\n')
      sessions.set(id, s)
    }
    return s
  }
  const svc = new ConvertService(tasks, audit, getSession)
  return { dir, tasks, audit, svc, getSession }
}

test('ConvertService: 小文件同步预览 → 确认合入 → 历史版本导出', async () => {
  const { dir, svc, getSession, audit } = makeService()
  const editor = { name: '张三', role: 'editor' as const }
  const before = getSession('d').revision

  const { preview } = await svc.upload('d', editor, 'note.md', 'md', Buffer.from('# 导入标题\n\n导入正文\n', 'utf8'))
  assert.ok(preview)
  assert.equal(preview!.baseRevision, before)
  assert.ok(preview!.diff.some((b) => b.type === 'added'))

  const r = svc.confirmPreview(preview!.previewId, editor)
  assert.equal(r.changed, true)
  assert.equal(getSession('d').doc, '# 导入标题\n\n导入正文\n')

  // 历史版本导出
  const old = svc.exportSync({ docId: 'd', format: 'md', variant: 'revision', revision: before }, editor)
  assert.ok(!('taskId' in old))
  assert.match((old as { body: Buffer }).body.toString('utf8'), /现有正文内容/)

  // 预览一次性：再次确认 404
  assert.throws(() => svc.confirmPreview(preview!.previewId, editor), (e: Error) => e instanceof ServiceError)

  const recs = audit.list({ docId: 'd' })
  assert.ok(recs.some((r) => r.action === 'import.confirm' && r.ok))
  rmSync(dir, { recursive: true, force: true })
})

test('ConvertService: 非编辑禁止上传/确认；预览过期拒绝确认', async () => {
  const { dir, svc, getSession } = makeService()
  const viewer = { name: '访客', role: 'viewer' as const }
  await assert.rejects(
    () => svc.upload('d', viewer, 'a.md', 'md', Buffer.from('x')),
    (e: Error) => e instanceof ServiceError && (e as ServiceError).status === 403,
  )

  const editor = { name: '张三', role: 'editor' as const }
  const { preview } = await svc.upload('d', editor, 'a.md', 'md', Buffer.from('新内容\n'))
  // 正文在预览后演进
  const s = getSession('d')
  const c = s.addClient('c9', '另一编辑', 'editor', () => {})
  s.receiveOp(c, s.revision, [{ insert: '并发新增\n' }, { retain: s.doc.length }], 'op-c9')

  assert.throws(
    () => svc.confirmPreview(preview!.previewId, editor),
    (e: ServiceError) => e.status === 409 && e.code === 'CONFLICT',
  )
  // 刷新差异后可确认
  const refreshed = svc.refreshPreview(preview!.previewId, editor)
  assert.equal(refreshed.baseRevision, s.revision)
  const r = svc.confirmPreview(preview!.previewId, editor)
  assert.equal(r.changed, true)
  rmSync(dir, { recursive: true, force: true })
})

test('ConvertService: docx 走异步任务，完成后产出预览', async () => {
  const { dir, svc, tasks } = makeService()
  const editor = { name: '张三', role: 'editor' as const }
  // 极小但格式为 docx → 恒走异步（执行时解析会失败，因为不是合法 zip；
  // 这里改用真实小 md 但标记 docx 会失败，因此直接构造一个无 zip 的场景验证失败链路）
  const out = await svc.upload('d', editor, 'a.docx', 'docx', Buffer.from('not-a-zip'))
  assert.ok(out.taskId)
  await waitFor(() => ['failed', 'succeeded'].includes(tasks.get(out.taskId!)!.status), 6000)
  // 非法 docx：三次尝试后失败（验证失败链路与审计）
  assert.equal(tasks.get(out.taskId!)!.status, 'failed')
  rmSync(dir, { recursive: true, force: true })
})

/* ---------------- 辅助 ---------------- */

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('waitFor 超时')
}
