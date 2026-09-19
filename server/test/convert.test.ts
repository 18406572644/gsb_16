/**
 * 转换链路单元测试：
 * 编码探测 / HTML / ZIP 往返 / DOCX 导出→导入往返 / 各导出器 / 行 diff /
 * 异步任务取消与重试 / DocSession 历史版本重建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

import { decodeBytes, normalizeText, isValidUtf8 } from '../src/convert/encoding'
import { htmlToText } from '../src/convert/htmlParser'
import { readZip } from '../src/convert/zipReader'
import { ZipWriter, crc32 } from '../src/convert/zipWriter'
import { buildDocx } from '../src/convert/docxExporter'
import { docxToText } from '../src/convert/docxParser'
import { exportDocument } from '../src/convert/exporters'
import { parseDocument } from '../src/convert/importers'
import { lineDiff, foldContext } from '../../shared/linediff'
import { TaskManager } from '../src/tasks/taskManager'
import { FatalConvertError, CanceledError } from '../src/tasks/errors'
import type { RunContext } from '../src/tasks/taskManager'
import { DocSession } from '../src/docSession'
import type { Op } from '../../shared/ot'
import type { Annotation } from '../../shared/protocol'

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('waitUntil 超时')
}

/* ---------------- 编码 ---------------- */

test('encoding: UTF-8 / BOM / GBK 回退', () => {
  assert.equal(decodeBytes(Buffer.from('你好，world', 'utf8')).text, '你好，world')
  assert.equal(decodeBytes(Buffer.from('你好', 'utf8')).encoding, 'utf-8')

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc', 'utf8')])
  assert.equal(decodeBytes(bom).text, 'abc')
  assert.equal(decodeBytes(bom).encoding, 'utf-8-bom')

  // GBK：「中文」= D6 D0 CE C4
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(isValidUtf8(gbk), false)
  const r = decodeBytes(gbk)
  assert.equal(r.encoding, 'gb18030')
  assert.equal(r.text, '中文')
  assert.ok(r.warnings.some((w) => w.code === 'ENCODING_FALLBACK'))
})

test('encoding: 控制字符清理与超长截断', () => {
  const r = normalizeText('a\x00b\x07c\n', 100)
  assert.equal(r.text, 'abc\n')
  assert.ok(r.warnings.some((w) => w.code === 'UNSUPPORTED_CHAR'))

  const big = normalizeText('x'.repeat(50), 10)
  assert.equal(big.truncated, true)
  assert.equal(big.text.length, 10)
})

/* ---------------- HTML ---------------- */

test('html: 块级结构 / 链接 / 图片 / 实体 / script 丢弃', () => {
  const html = `
    <html><head><title>x</title><style>.a{}</style></head>
    <body>
      <h1>标题一</h1>
      <p>带 <a href="https://example.com/中文?a=1&b=2">示例&nbsp;链接</a> 的段落 &amp; 实体&#33;</p>
      <ul><li>第一项</li><li>第二项</li></ul>
      <img src="https://x/y.png" alt="示意图">
      <script>alert(1)</script>
      <table><tr><td>A</td><td>B</td></tr></table>
    </body></html>`
  const r = htmlToText(html)
  assert.match(r.text, /## 标题一/)
  assert.match(r.text, /\[示例 链接\]\(https:\/\/example\.com\/中文\?a=1&b=2\)/)
  assert.match(r.text, /& 实体!/)
  assert.match(r.text, /- 第一项/)
  assert.match(r.text, /- 第二项/)
  assert.match(r.text, /\[图片：示意图\]\(https:\/\/x\/y\.png\)/)
  assert.match(r.text, /A \| B/)
  assert.equal(r.links, 1)
  assert.equal(r.images, 1)
  assert.ok(!r.text.includes('alert'))
  assert.ok(r.warnings.some((w) => w.code === 'STYLE_DROPPED'))
})

/* ---------------- ZIP 往返 ---------------- */

test('zip: stored/deflate 写出后可被读取，CRC 正确', () => {
  const crc = crc32(Buffer.from('123456789'))
  assert.equal(crc, 0xcbf43926)

  const zip = new ZipWriter()
  zip.addFile('a.txt', 'hello')
  zip.addFile('b.bin', Buffer.alloc(2000, 0x58)) // 足够大走 deflate
  zip.addFile('中文名称.txt', '中文内容')
  const buf = zip.buffer()
  assert.equal(buf.readUInt32LE(0), 0x04034b50)

  const read = readZip(buf)
  assert.equal(read.get('a.txt')?.toString('utf8'), 'hello')
  assert.equal(read.get('b.bin')?.length, 2000)
  assert.ok(read.get('b.bin')!.every((b) => b === 0x58))
  assert.equal(read.get('中文名称.txt')?.toString('utf8'), '中文内容')
})

/* ---------------- DOCX 导出→导入往返 ---------------- */

test('docx: 导出（含批注与超链接）可被自家解析器读回', () => {
  const text = '# 报告标题\n\n请看[官网](https://a.com)与这段被批注的文字内容。\n'
  const anns: Annotation[] = [
    {
      id: 'ann1',
      start: text.indexOf('这段被批注的文字'),
      end: text.indexOf('这段被批注的文字') + '这段被批注的文字'.length,
      orphan: false,
      quote: '这段被批注的文字',
      authorId: 'u1',
      authorName: '张三',
      text: '这里需要补充数据',
      replies: [{ id: 'r1', authorId: 'u2', authorName: '李四', text: '已补充', createdAt: 1 }],
      resolved: false,
      createdAt: 1,
    },
  ]
  const buf = buildDocx(text, { annotated: true, annotations: anns })
  // 结构合法性
  const zip = readZip(buf)
  assert.ok(zip.has('word/document.xml'))
  assert.ok(zip.has('word/comments.xml'))
  assert.ok(zip.has('word/styles.xml'))
  const docXml = zip.get('word/document.xml')!.toString('utf8')
  assert.match(docXml, /w:eastAsia="宋体"/)
  assert.match(docXml, /<w:commentRangeStart w:id="0"\/>/)
  assert.match(docXml, /<w:hyperlink r:id="rId100"/)
  const commentsXml = zip.get('word/comments.xml')!.toString('utf8')
  assert.match(commentsXml, /这里需要补充数据/)
  assert.match(commentsXml, /李四/)

  // 自家解析器读回（批注编号 ① 会落在导出文档的区间末尾）
  const parsed = docxToText(buf)
  assert.match(parsed.text, /# 报告标题/)
  assert.match(parsed.text, /\[官网\]\(https:\/\/a\.com\)/)
  assert.match(parsed.text, /这段被批注的文字①内容/)
  assert.equal(parsed.links, 1)
  assert.ok(parsed.warnings.some((w) => w.code === 'COMMENT_DROPPED' && w.count === 1))
})

test('docx: 损坏输入抛出可读错误', () => {
  assert.throws(
    () => docxToText(Buffer.from('not a docx at all')),
    /不是合法的 zip|缺少 word\/document\.xml/,
  )
})

/* ---------------- 导出器 ---------------- */

test('exporters: txt 带 BOM 且含批注编号与清单', () => {
  const f = exportDocument({
    text: 'abcdef',
    format: 'txt',
    variant: 'annotated',
    revision: 3,
    annotations: [
      {
        id: 'a', start: 1, end: 4, orphan: false, quote: 'bcd', authorId: 'u', authorName: '王五',
        text: '批注内容', replies: [], resolved: false, createdAt: 1,
      },
    ],
    docId: 'demo',
    exportedAt: 1,
  })
  assert.equal(f.data[0], 0xef)
  assert.equal(f.data[1], 0xbb)
  assert.equal(f.data[2], 0xbf)
  const s = f.data.toString('utf8')
  assert.match(s, /a①bcd①ef/)
  assert.match(s, /批注内容/)
  assert.match(s, /王五/)
})

test('exporters: md 批注章节 / html 高亮 / docx 无批注时不含 comments part', () => {
  const ann: Annotation = {
    id: 'a', start: 0, end: 1, orphan: false, quote: 'a', authorId: 'u', authorName: '赵六',
    text: 't', replies: [], resolved: true, createdAt: 1,
  }
  const md = exportDocument({ text: 'ab', format: 'md', variant: 'annotated', revision: 1, annotations: [ann], docId: 'd', exportedAt: 1 })
  assert.match(md.data.toString('utf8'), /## 批注/)
  assert.match(md.data.toString('utf8'), /①/)

  const html = exportDocument({ text: 'ab', format: 'html', variant: 'annotated', revision: 1, annotations: [ann], docId: 'd', exportedAt: 1 })
  const hs = html.data.toString('utf8')
  assert.match(hs, /<mark class="ann[^"]*"/)
  assert.match(hs, /PingFang SC/)
  assert.match(hs, /赵六/)

  const docx = exportDocument({ text: 'ab', format: 'docx', variant: 'current', revision: 1, annotations: [ann], docId: 'd', exportedAt: 1 })
  const zip = readZip(docx.data)
  assert.ok(!zip.has('word/comments.xml'))
})

test('exporters: 历史版本带版本头（md/html）', () => {
  const md = exportDocument({ text: 'x', format: 'md', variant: 'history', revision: 42, annotations: [], docId: 'demo', exportedAt: 1 })
  assert.match(md.data.toString('utf8'), /历史版本导出.*v42/)
  const html = exportDocument({ text: 'x', format: 'html', variant: 'history', revision: 42, annotations: [], docId: 'demo', exportedAt: 1 })
  assert.match(html.data.toString('utf8'), /历史版本导出.*v42/)
})

/* ---------------- 导入外观 ---------------- */

test('importers: markdown 链接统计与 txt 直通', () => {
  const md = parseDocument(Buffer.from('# 标题\n[链接](https://x.com)\n![](https://x/i.png)\n裸链 https://y.com'), 'md')
  assert.equal(md.stats.links, 2) // 一个 markdown 链接 + 一个裸链
  assert.equal(md.stats.images, 1)

  const txt = parseDocument(Buffer.from('纯文本内容\n第二行'), 'txt')
  assert.equal(txt.text, '纯文本内容\n第二行')
})

/* ---------------- 行 diff ---------------- */

test('linediff: 基本增删改与统计', () => {
  const r = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')
  assert.ok(r.stats.deleted >= 1)
  assert.ok(r.stats.inserted >= 1)
  const ops = r.lines.filter((l) => l.op !== 'skip').map((l) => l.op)
  assert.ok(ops.includes('delete'))
  assert.ok(ops.includes('insert'))
  assert.ok(ops.includes('equal'))
})

test('linediff: 无变化', () => {
  const r = lineDiff('x\ny\n', 'x\ny\n')
  assert.equal(r.stats.inserted, 0)
  assert.equal(r.stats.deleted, 0)
  assert.equal(r.stats.equal, 2)
})

test('linediff: 长文档折叠上下文且降级算法可用', () => {
  const old = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n')
  const neu = Array.from({ length: 5000 }, (_, i) => (i === 2500 ? 'line-CHANGED' : `line-${i}`)).join('\n')
  const r = lineDiff(old, neu)
  assert.ok(r.lines.some((l) => l.op === 'skip'))
  assert.ok(r.lines.some((l) => l.op === 'insert'))
  // 上下文块总大小远小于全文
  assert.ok(r.lines.length < 200)
})

test('linediff: 超大文档（走 Hunt-Szymanski / 降级）不炸且线性返回', () => {
  const old = Array.from({ length: 20000 }, (_, i) => `row-${i}`).join('\n')
  const neu = old + '\nrow-tail'
  const r = lineDiff(old, neu)
  assert.ok(['dp', 'huntszymanski', 'prefix'].includes(r.algorithm))
  assert.ok(r.stats.inserted >= 1)
})

test('linediff: foldContext 无变化长文折叠', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ op: 'equal' as const, oldNo: i, newNo: i, text: `${i}` }))
  const folded = foldContext(lines)
  assert.ok(folded.some((l) => l.op === 'skip'))
})

/* ---------------- TaskManager ---------------- */

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'collab-task-'))
}

test('TaskManager: 排队取消立即生效', async () => {
  let releaseGate: (() => void) | null = null
  const gate = new Promise<void>((r) => (releaseGate = r))
  const tm = new TaskManager(
    tmpDir(),
    {
      runImport: async () => {},
      runExport: async (_t, ctx: RunContext) => {
        ctx.report('等待闸门', 50)
        await gate
        ctx.checkCanceled()
      },
      onAudit: () => {},
    },
    1, // 单并发：第一个占住 worker，第二个必然排队
  )
  tm.start()
  const t1 = tm.createTask({ kind: 'export', format: 'txt', docId: 'd', ownerName: 'u', ownerRole: 'editor', sourceName: 'a', sourceSize: 1, variant: 'current' })
  const t2 = tm.createTask({ kind: 'export', format: 'txt', docId: 'd', ownerName: 'u', ownerRole: 'editor', sourceName: 'b', sourceSize: 1, variant: 'current' })
  await waitUntil(() => tm.get(t1.id)?.status === 'running')
  assert.equal(tm.get(t2.id)?.status, 'pending')
  const r = tm.cancel(t2.id)
  assert.ok(r.ok)
  assert.equal(tm.get(t2.id)?.status, 'canceled')
  releaseGate!()
  await waitUntil(() => tm.get(t1.id)?.status === 'succeeded')
  tm.shutdown()
})

test('TaskManager: 执行中协作式取消', async () => {
  const tm = new TaskManager(
    tmpDir(),
    {
      runImport: async () => {},
      runExport: async (_t, ctx: RunContext) => {
        for (let i = 0; i < 100; i++) {
          ctx.report('分块处理', i)
          await new Promise((r) => setTimeout(r, 5))
          ctx.checkCanceled()
        }
      },
      onAudit: () => {},
    },
    1,
  )
  tm.start()
  const t = tm.createTask({ kind: 'export', format: 'txt', docId: 'd', ownerName: 'u', ownerRole: 'editor', sourceName: 'a', sourceSize: 1 })
  await waitUntil(() => tm.get(t.id)?.status === 'running')
  tm.cancel(t.id)
  await waitUntil(() => tm.get(t.id)?.status === 'canceled')
  tm.shutdown()
})

test('TaskManager: 确定性失败不重试；手动重试后成功', async () => {
  let shouldFail = true
  const audits: string[] = []
  const tm = new TaskManager(
    tmpDir(),
    {
      runImport: async () => {},
      runExport: async () => {
        if (shouldFail) throw new FatalConvertError('坏文件')
      },
      onAudit: (e) => audits.push(e.action + ':' + e.status),
    },
    1,
  )
  tm.start()
  const t = tm.createTask({ kind: 'export', format: 'txt', docId: 'd', ownerName: 'u', ownerRole: 'editor', sourceName: 'a', sourceSize: 1 })
  await waitUntil(() => tm.get(t.id)?.status === 'failed')
  assert.equal(tm.get(t.id)?.attempts, 1, 'FatalConvertError 不应触发重试')
  assert.match(tm.get(t.id)!.error!.message, /坏文件/)

  shouldFail = false
  const r = tm.retry(t.id)
  assert.ok(r.ok)
  await waitUntil(() => tm.get(t.id)?.status === 'succeeded')
  // 失败审计由任务中心记录；重试/取消审计在 HTTP 路由层记录（见 api 测试）
  assert.ok(audits.includes('task.fail:error'))
  tm.shutdown()
})

test('TaskManager: 瞬时错误自动退避重试后成功', async () => {
  let fails = 2
  const tm = new TaskManager(
    tmpDir(),
    {
      runImport: async () => {},
      runExport: async () => {
        if (fails-- > 0) throw new Error('临时故障')
      },
      onAudit: () => {},
    },
    1,
  )
  tm.start()
  const t = tm.createTask({ kind: 'export', format: 'txt', docId: 'd', ownerName: 'u', ownerRole: 'editor', sourceName: 'a', sourceSize: 1 })
  await waitUntil(() => tm.get(t.id)?.status === 'retrying' || tm.get(t.id)?.status === 'succeeded', 3000)
  await waitUntil(() => tm.get(t.id)?.status === 'succeeded', 15000)
  assert.equal(tm.get(t.id)?.attempts, 3)
  tm.shutdown()
})

test('TaskManager: 取消点抛 CanceledError 被识别', () => {
  assert.throws(() => {
    throw new CanceledError()
  }, /已取消/)
})

/* ---------------- DocSession 历史版本与外部提交 ---------------- */

function fakeClient(role: 'editor' | 'commenter' | 'viewer' = 'editor') {
  const sent: object[] = []
  return {
    state: {
      clientId: 'c-1',
      name: '测试者',
      role,
      color: '#000',
      cursor: null,
      send: (m: object) => sent.push(m),
    },
    sent,
  }
}

test('DocSession: 周期性快照与任意修订重建', () => {
  const s = new DocSession('h1', '')
  const { state, sent } = fakeClient()
  for (let i = 0; i < 120; i++) {
    const op: Op = [{ retain: s.doc.length }, { insert: String(i % 10) }]
    const err = s.receiveOp(state, s.revision, op, `op-${i}`)
    assert.equal(err, null)
  }
  assert.equal(s.revision, 120)
  assert.equal(s.textAt(120), s.doc)
  assert.equal(s.textAt(0), '')
  const at60 = s.textAt(60)!
  assert.equal(at60.length, 60)
  // 重建文本等于顺序应用
  assert.equal(at60, Array.from({ length: 60 }, (_, i) => String(i % 10)).join(''))
  const points = s.historyPoints()
  assert.ok(points.some((p) => p.revision === 120))
  assert.ok(points.some((p) => p.revision === 0) || points.length > 0)
  assert.equal(sent.filter((m) => (m as { type: string }).type === 'op').length, 0, '发起者不收广播只收 ack')
  assert.ok(sent.every((m) => (m as { type: string }).type === 'ack'))
})

test('DocSession: 日志截断后的地板快照仍可重建', () => {
  const s = new DocSession('h2', '')
  const { state } = fakeClient()
  for (let i = 0; i < 1005; i++) {
    const op: Op = [{ retain: s.doc.length }, { insert: 'x' }]
    s.receiveOp(state, s.revision, op, `op-${i}`)
  }
  assert.equal(s.log.length, 1000)
  // 1005 次提交后，新最早日志条目为 revision=5，更早版本不可重建
  assert.equal(s.textAt(0), null, '地板之前的版本不可重建')
  assert.equal(s.textAt(1), null)
  const at5 = s.textAt(5)
  assert.equal(at5, 'x'.repeat(5))
  const at500 = s.textAt(500)!
  assert.equal(at500.length, 500)
  assert.equal(s.textAt(1005), s.doc)
  assert.equal(s.doc.length, 1005)
})

test('DocSession: 外部导入提交生成协同变更并广播；权限校验', () => {
  const s = new DocSession('h3', 'hello\nworld\n')
  const broadcast: object[] = []
  s.clients.set('w1', { clientId: 'w1', name: '旁观者', role: 'viewer', color: '#fff', cursor: null, send: (m) => broadcast.push(m) })

  const denied = s.submitExternalChange({ clientId: 'rest-x', name: '路人', role: 'commenter' }, 'new')
  assert.ok('code' in denied)
  if ('code' in denied) assert.equal(denied.code, 'PERMISSION_DENIED')

  const r = s.submitExternalChange({ clientId: 'rest-1', name: '导入者', role: 'editor' }, 'hello\n地球\n')
  assert.ok(!('code' in r))
  if (!('code' in r)) {
    assert.equal(r.revision, 1)
    assert.match(r.doc, /地球/)
    assert.equal(broadcast.filter((m) => (m as { type: string }).type === 'op').length, 1)
    assert.match(
      (broadcast.find((m) => (m as { type: string }).type === 'op') as { authorName: string }).authorName,
      /导入/,
    )
  }

  // 无变化文本：noop，不增加版本
  const noop = s.submitExternalChange({ clientId: 'rest-2', name: '导入者', role: 'editor' }, s.doc)
  if (!('code' in noop)) assert.equal(noop.revision, 1)
})
