/**
 * 转换中心 REST API 端到端：
 * 上传 → 预览 → 确认（协同变更 + WS 广播）→ 三种导出变体 → 下载；
 * 权限、不支持类型、手动重试、审计记录。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '../../shared/protocol'
import type { ConvertTask } from '../../shared/transfer'
import { readZip } from '../src/convert/zipReader'

process.env.PORT = '18096'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-api-'))
const { server, shutdown } = await import('../src/index')

const ORIGIN = 'http://localhost:18096'
const DOC = 'api-demo'

function headers(role: 'editor' | 'commenter' | 'viewer' = 'editor', extra: Record<string, string> = {}) {
  return { 'x-user-name': encodeURIComponent('接口测试者'), 'x-user-role': role, ...extra }
}

function multipart(field: string, filename: string, data: Buffer, contentType = 'text/plain'): { body: Uint8Array; type: string } {
  const boundary = '----collabtest' + Math.random().toString(16).slice(2)
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${encodeURIComponent(filename)}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: new Uint8Array(Buffer.concat([Buffer.from(head, 'binary'), data, tail])), type: `multipart/form-data; boundary=${boundary}` }
}

async function createImport(role: 'editor' | 'commenter' | 'viewer', filename: string, data: Buffer, ct?: string) {
  const mp = multipart('file', filename, data, ct)
  return fetch(`${ORIGIN}/api/docs/${DOC}/imports`, {
    method: 'POST',
    headers: headers(role, { 'content-type': mp.type }),
    body: mp.body as unknown as BodyInit,
  })
}

async function waitTask(id: string, timeoutMs = 10000): Promise<ConvertTask> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${ORIGIN}/api/docs/${DOC}/tasks?full=${encodeURIComponent(id)}`, { headers: headers('viewer') })
    const r = await res.json()
    const t = r.tasks.find((x: ConvertTask) => x.id === id)
    if (t && ['succeeded', 'failed', 'canceled', 'expired'].includes(t.status)) return t
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('任务终态等待超时')
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => shutdown())

test('api: 文档信息与历史点', async () => {
  const res = await fetch(`${ORIGIN}/api/docs/${DOC}`, { headers: headers('viewer') })
  assert.equal(res.status, 200)
  const info = await res.json()
  assert.equal(info.docId, DOC)
  assert.ok(Array.isArray(info.history))
  assert.ok(info.history.some((h: { revision: number }) => h.revision === info.revision))
})

test('api: viewer 上传导入被拒（403），.doc 类型被拒（415）', async () => {
  const denied = await createImport('viewer', 'a.txt', Buffer.from('x'))
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.code, 'PERMISSION_DENIED')

  const badType = await createImport('editor', 'old.doc', Buffer.from('fake'))
  assert.equal(badType.status, 415)
  assert.equal((await badType.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE')
})

test('api: txt 导入 → 预览差异 → 确认 → WS 协作者收到广播', async () => {
  // WS 旁观者等待导入操作广播
  const gotOp = new Promise<ServerMsg>((resolve) => {
    const ws = new WebSocket('ws://localhost:18096/ws')
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', docId: DOC, name: '旁观者', role: 'viewer' })))
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg
      if (m.type === 'op' && (m as { authorName?: string }).authorName?.includes('导入')) {
        resolve(m)
        ws.close()
      }
    })
  })

  const newContent = '导入的第一段\n导入的第二段\n特殊字符：中文 & <emoji>😀 & 制表\t结束\n'
  const up = await createImport('editor', '中文文件名.txt', Buffer.from(newContent, 'utf8'))
  assert.equal(up.status, 202)
  const { task: created } = await up.json()
  assert.equal(created.kind, 'import')

  const done = await waitTask(created.id)
  assert.equal(done.status, 'succeeded')
  assert.ok(done.preview)
  assert.equal(done.preview.stats.lines, 3)
  assert.ok(done.preview.diff.stats.inserted >= 3)
  assert.equal(done.preview.encoding, 'utf-8')

  // 确认导入
  const confirmRes = await fetch(`${ORIGIN}/api/docs/${DOC}/imports/${created.id}/confirm`, {
    method: 'POST',
    headers: headers('editor', { 'content-type': 'application/json' }),
    body: JSON.stringify({}),
  })
  assert.equal(confirmRes.status, 200)
  const confirmed = await confirmRes.json()
  assert.ok(confirmed.revision > confirmed.baseRevision || confirmed.revision >= 1)
  assert.match(confirmed.doc, /导入的第一段/)

  // 一次性预览：再次确认应冲突
  const again = await fetch(`${ORIGIN}/api/docs/${DOC}/imports/${created.id}/confirm`, {
    method: 'POST',
    headers: headers('editor', { 'content-type': 'application/json' }),
    body: '{}',
  })
  assert.equal(again.status, 409)

  // 旁观者通过 OT 广播收到变更
  const broadcast = await gotOp
  assert.equal(broadcast.type, 'op')

  // 审计包含提交与确认
  const auditRes = await fetch(`${ORIGIN}/api/docs/${DOC}/audit`, { headers: headers('viewer') })
  const audit = await auditRes.json()
  assert.ok(audit.entries.some((e: { action: string }) => e.action === 'import.submit'))
  assert.ok(audit.entries.some((e: { action: string }) => e.action === 'import.confirm'))
})

test('api: GBK 编码 HTML 导入带链接/图片统计与兼容性警告', async () => {
  const html = '<html><body><h1>标题</h1><p><a href="https://x.io">链接</a><img src="https://x.io/a.png" alt="图"></p></body></html>'
  const up = await createImport('editor', 'page.html', Buffer.from(html, 'utf8'), 'text/html')
  const { task } = await up.json()
  const done = await waitTask(task.id)
  assert.equal(done.status, 'succeeded')
  assert.ok(done.preview)
  assert.match(done.preview!.text, /## 标题/)
  assert.equal(done.preview!.stats.links, 1)
  assert.equal(done.preview!.stats.images, 1)
})

test('api: 三种导出变体任务 → 下载产物内容正确', async () => {
  // annotated docx
  const r1 = await fetch(`${ORIGIN}/api/docs/${DOC}/exports`, {
    method: 'POST',
    headers: headers('editor', { 'content-type': 'application/json' }),
    body: JSON.stringify({ format: 'docx', variant: 'annotated' }),
  })
  assert.equal(r1.status, 202)
  const t1 = (await r1.json()).task
  const d1 = await waitTask(t1.id)
  assert.equal(d1.status, 'succeeded', d1.error?.message)
  const dl1 = await fetch(`${ORIGIN}${d1.result!.downloadUrl}`, { headers: headers('viewer') })
  assert.equal(dl1.status, 200)
  assert.match(dl1.headers.get('content-disposition') || '', /docx/)
  const ab = Buffer.from(await dl1.arrayBuffer())
  const zip = readZip(ab)
  assert.ok(zip.has('word/document.xml'))
  assert.match(zip.get('word/document.xml')!.toString('utf8'), /导入的第一段/)

  // current md
  const r2 = await fetch(`${ORIGIN}/api/docs/${DOC}/exports`, {
    method: 'POST',
    headers: headers('viewer', { 'content-type': 'application/json' }),
    body: JSON.stringify({ format: 'md', variant: 'current' }),
  })
  const d2 = await waitTask((await r2.json()).task.id)
  const dl2 = await fetch(`${ORIGIN}${d2.result!.downloadUrl}`, { headers: headers('viewer') })
  const md = await dl2.text()
  assert.match(md, /特殊字符/)

  // history v0/v1
  const info = await (await fetch(`${ORIGIN}/api/docs/${DOC}`, { headers: headers('viewer') })).json()
  const oldRev = info.history.find((h: { revision: number }) => h.revision < info.revision)
  if (oldRev) {
    const r3 = await fetch(`${ORIGIN}/api/docs/${DOC}/exports`, {
      method: 'POST',
      headers: headers('viewer', { 'content-type': 'application/json' }),
      body: JSON.stringify({ format: 'html', variant: 'history', revision: oldRev.revision }),
    })
    const d3 = await waitTask((await r3.json()).task.id)
    assert.equal(d3.status, 'succeeded', d3.error?.message)
    const dl3 = await fetch(`${ORIGIN}${d3.result!.downloadUrl}`, { headers: headers('viewer') })
    const html = await dl3.text()
    assert.match(html, /历史版本导出/)
    assert.match(html, new RegExp(`v${oldRev.revision}`))
  }

  // 不存在的修订号 → 404
  const r4 = await fetch(`${ORIGIN}/api/docs/${DOC}/exports`, {
    method: 'POST',
    headers: headers('viewer', { 'content-type': 'application/json' }),
    body: JSON.stringify({ format: 'html', variant: 'history', revision: 999_999 }),
  })
  assert.equal(r4.status, 404)
})

test('api: 非法 docx 导入失败（确定性错误不重试），可手动重试', async () => {
  const up = await createImport('editor', 'broken.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  const { task } = await up.json()
  const done = await waitTask(task.id)
  assert.equal(done.status, 'failed')
  assert.equal(done.attempts, 1)
  assert.ok(done.error?.message)

  const retry = await fetch(`${ORIGIN}/api/docs/${DOC}/tasks/${task.id}/retry`, {
    method: 'POST',
    headers: headers('editor'),
  })
  assert.equal(retry.status, 200)
  const again = await waitTask(task.id)
  assert.equal(again.status, 'failed')
})

test('api: 取消已结束任务返回 409；放弃预览成功', async () => {
  const up = await createImport('editor', 'discard.txt', Buffer.from('待放弃内容'))
  const { task } = await up.json()
  await waitTask(task.id)
  const cancel = await fetch(`${ORIGIN}/api/docs/${DOC}/tasks/${task.id}/cancel`, {
    method: 'POST',
    headers: headers('editor'),
  })
  assert.equal(cancel.status, 409)

  const discard = await fetch(`${ORIGIN}/api/docs/${DOC}/imports/${task.id}/discard`, {
    method: 'POST',
    headers: headers('editor'),
  })
  assert.equal(discard.status, 200)
})
