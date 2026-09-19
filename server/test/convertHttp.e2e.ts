/**
 * 转换中心 HTTP 路由级端到端：真实 HTTP 服务 + multipart 上传 +
 * 同步预览/确认 + 异步导出任务轮询 + 产物下载（防 resultId 接错回归）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18100
const DATA_DIR = mkdtempSync(join(tmpdir(), 'conv-http-e2e-'))
process.env.PORT = String(PORT)
process.env.DATA_DIR = DATA_DIR
const { server, shutdown } = await import('../src/index')

const B = `http://localhost:${PORT}`
const H = { 'x-actor-name': encodeURIComponent('张三'), 'x-actor-role': 'editor' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

before(() => {
  if (!server.listening) throw new Error('HTTP 服务未启动')
})
after(() => {
  rmSync(DATA_DIR, { recursive: true, force: true })
  shutdown()
})

function multipart(field: string, filename: string, content: string, boundary = '----testboundary'): { body: Buffer; contentType: string } {
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    body: Buffer.concat([head, Buffer.from(content, 'utf8'), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

test('HTTP: 上传→确认→历史版本导出→异步导出任务→产物下载', async () => {
  // 1. 上传
  const mp = multipart('file', 'note.md', '# HTTP 导入标题\n\n正文含[链接](https://a.com)。\n')
  const up = await fetch(`${B}/api/convert/import/preview?docId=hd1`, {
    method: 'POST',
    headers: { ...H, 'content-type': mp.contentType },
    body: new Uint8Array(mp.body),
  })
  assert.equal(up.status, 200)
  const upj = await up.json() as { preview: { previewId: string; baseRevision: number } }
  assert.ok(upj.preview.previewId)

  // 2. 无身份头 → 401
  const noauth = await fetch(`${B}/api/convert/tasks?docId=hd1`)
  assert.equal(noauth.status, 401)

  // 3. viewer 确认 → 403
  const denied = await fetch(`${B}/api/convert/import/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-name': 'v', 'x-actor-role': 'viewer' },
    body: JSON.stringify({ previewId: upj.preview.previewId }),
  })
  assert.equal(denied.status, 403)

  // 4. editor 确认
  const ok = await fetch(`${B}/api/convert/import/confirm`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: upj.preview.previewId }),
  })
  assert.equal(ok.status, 200)
  const okj = await ok.json() as { revision: number; changed: boolean }
  assert.equal(okj.changed, true)
  assert.equal(okj.revision, 1)

  // 5. 历史版本列表包含导入来源
  const revs = await (await fetch(`${B}/api/convert/revisions?docId=hd1`, { headers: H })).json()
  assert.equal(revs.revisions[0].external.kind, 'import')

  // 6. 异步导出任务
  const ex = await fetch(`${B}/api/convert/export?docId=hd1`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'html', variant: 'current', async: true }),
  })
  assert.equal(ex.status, 202)
  const { taskId } = await ex.json() as { taskId: string }

  let status = ''
  let resultId = ''
  for (let n = 0; n < 40; n++) {
    const j = await (await fetch(`${B}/api/convert/tasks/${taskId}`, { headers: H })).json()
    status = j.task.status
    resultId = j.task.resultId
    if (status === 'succeeded' || status === 'failed') break
    await sleep(100)
  }
  assert.equal(status, 'succeeded')
  assert.ok(resultId, '任务应记录 resultId')

  // 7. 产物下载（路由必须使用 task.resultId 而非任务 id）
  const dl = await fetch(`${B}/api/convert/tasks/${taskId}/download`, { headers: H })
  assert.equal(dl.status, 200)
  const buf = Buffer.from(await dl.arrayBuffer())
  assert.ok(buf.length > 100)
  const html = buf.toString('utf8')
  assert.match(html, /HTTP 导入标题/)
  assert.match(dl.headers.get('content-disposition') || '', /filename\*=UTF-8''/) // 中文文件名走 RFC5987

  // 8. 审计包含关键动作
  const audit = await (await fetch(`${B}/api/convert/audit?docId=hd1`, { headers: H })).json()
  const actions = audit.records.map((r: { action: string }) => r.action)
  assert.ok(actions.includes('import.confirm'))
  assert.ok(actions.includes('task.create'))
  assert.ok(actions.includes('export.download'))
})

test('HTTP: 不支持的文件类型 → 415', async () => {
  const mp = multipart('file', 'virus.exe', 'xx')
  const res = await fetch(`${B}/api/convert/import/preview?docId=hd2`, {
    method: 'POST',
    headers: { ...H, 'content-type': mp.contentType },
    body: new Uint8Array(mp.body),
  })
  assert.equal(res.status, 415)
})
