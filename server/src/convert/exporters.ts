/**
 * 文档导出外观层：txt / md / html。
 *
 * - txt：UTF-8（带 BOM，确保 Windows 记事本正确识别中文）；批注以 ①…① 行内编号 + 文末清单呈现；
 * - md：保留 Markdown 原文语法；批注锚点同上，文末「批注」章节含引用、作者、回复、状态；
 * - html：独立 UTF-8 页面，中文字体栈（PingFang/微软雅黑/宋体），批注区间 <mark> 高亮、
 *   悬停显示内容，文末评论区含锚点链接；历史版本附带版本信息头。
 *
 * 特殊字符：HTML 侧全部转义；空字节等控制字符已在导入侧处理，导出侧再兜底一次。
 */
import type { Annotation } from '../../../shared/protocol'
import type { ExportVariant } from '../../../shared/transfer'
import { buildDocx } from './docxExporter'

export interface ExportInput {
  text: string
  format: 'txt' | 'md' | 'html' | 'docx'
  variant: ExportVariant
  revision: number
  annotations: Annotation[]
  docId: string
  exportedAt: number
}

export interface ExportFile {
  fileName: string
  contentType: string
  data: Buffer
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
const markOf = (i: number) => CIRCLED[i] ?? `［${i + 1}］`

function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface NumberedAnn {
  ann: Annotation
  no: number
  mark: string
}

/** 在纯文本中插入批注编号标记（区间起止处各放一个相同符号，孤儿批注放单个） */
function annotatePlainText(text: string, anns: Annotation[]): { text: string; numbered: NumberedAnn[] } {
  const active = anns
    .filter((a) => !a.orphan && a.start < a.end)
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const orphan = anns.filter((a) => a.orphan || a.start === a.end).sort((a, b) => a.start - b.start)

  const numbered: NumberedAnn[] = []
  const edits: { pos: number; insert: string }[] = []
  active.forEach((ann, i) => {
    const mark = markOf(i)
    numbered.push({ ann, no: i + 1, mark })
    const start = Math.min(ann.start, text.length)
    const end = Math.min(ann.end, text.length)
    edits.push({ pos: end, insert: mark })
    edits.push({ pos: start, insert: mark })
  })
  orphan.forEach((ann, i) => {
    const idx = active.length + i
    const mark = markOf(idx)
    numbered.push({ ann, no: idx + 1, mark })
    edits.push({ pos: Math.min(ann.start, text.length), insert: `📌${mark}` })
  })

  edits.sort((a, b) => b.pos - a.pos)
  let out = text
  for (const e of edits) out = out.slice(0, e.pos) + e.insert + out.slice(e.pos)
  return { text: out, numbered }
}

function buildCommentsText(numbered: NumberedAnn[], variant: ExportVariant): string {
  if (!numbered.length) return ''
  const lines: string[] = ['', '', '────────── 批注 ──────────']
  for (const n of numbered) {
    const a = n.ann
    lines.push(
      `${n.mark} ${a.resolved ? '【已解决】' : ''}${a.authorName} · ${fmtTime(a.createdAt)}`,
    )
    lines.push(`   原文：${(a.quote || '（空）').replace(/\n/g, ' ').slice(0, 300)}`)
    lines.push(`   ${a.text.replace(/\n/g, '\n   ')}`)
    for (const r of a.replies) {
      lines.push(`   └ ${r.authorName}：${r.text.replace(/\n/g, '\n     ')}`)
    }
    lines.push('')
  }
  void variant
  return lines.join('\n')
}

function exportTxt(input: ExportInput): Buffer {
  const annotated = input.format === 'txt' && input.variant === 'annotated'
  const body = annotated ? annotatePlainText(stripControl(input.text), input.annotations) : null
  const text = body
    ? body.text + buildCommentsText(body.numbered, input.variant)
    : stripControl(input.text)
  // UTF-8 BOM：Windows 记事本/老式办公软件识别中文所必需
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
}

function exportMd(input: ExportInput): Buffer {
  const header =
    input.variant === 'history'
      ? `> 📜 历史版本导出 · 文档 \`${input.docId}\` · 修订 v${input.revision} · ${fmtTime(input.exportedAt)}\n>\n\n`
      : ''
  let body = stripControl(input.text)
  if (input.variant === 'annotated') {
    const r = annotatePlainText(body, input.annotations)
    body = r.text
    if (r.numbered.length) {
      const parts = ['', '---', '', '## 批注', '']
      for (const n of r.numbered) {
        const a = n.ann
        const quote = (a.quote || '').replace(/\n/g, ' ').slice(0, 300)
        parts.push(
          `### ${n.mark} ${a.resolved ? '✅ 已解决 · ' : ''}${a.authorName} · <small>${fmtTime(a.createdAt)}</small>`,
          '',
          `> ${quote || '（锚点原文已删除）'}`,
          '',
          a.text,
          '',
        )
        for (const rep of a.replies) {
          parts.push(`- **${rep.authorName}**：${rep.text}`, '')
        }
      }
      body += parts.join('\n')
    }
  }
  return Buffer.from(header + body, 'utf8')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function exportHtml(input: ExportInput): Buffer {
  const text = stripControl(input.text)
  const anns = input.variant === 'annotated' ? input.annotations : []

  // 按批注区间把正文切分为高亮段
  const bounds = new Set<number>([0, text.length])
  for (const a of anns) {
    if (a.orphan) {
      bounds.add(Math.min(a.start, text.length))
      continue
    }
    bounds.add(Math.min(a.start, text.length))
    bounds.add(Math.min(a.end, text.length))
  }
  const pts = [...bounds].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b)

  const coverAt = (from: number, to: number) =>
    anns.filter((a) => !a.orphan && a.start < to && a.end > from)
  const orphanAt = new Map<number, string[]>()
  anns
    .filter((a) => a.orphan)
    .forEach((a) => {
      const p = Math.min(a.start, text.length)
      const list = orphanAt.get(p) ?? []
      list.push(a.id)
      orphanAt.set(p, list)
    })
  const annMap = new Map(anns.map((a, i) => [a.id, { ann: a, no: i + 1, mark: markOf(i) }]))

  let bodyHtml = ''
  const orphanEmitted = new Set<number>()
  const emitOrphans = (pos: number) => {
    if (orphanEmitted.has(pos)) return
    for (const id of orphanAt.get(pos) ?? []) {
      const n = annMap.get(id)!
      bodyHtml += `<sup class="orphan" id="src-${escapeHtml(id)}"><a href="#ann-${escapeHtml(id)}">📌${n.mark}</a></sup>`
    }
    orphanEmitted.add(pos)
  }
  for (let k = 0; k < pts.length - 1; k++) {
    const from = pts[k]
    const to = pts[k + 1]
    emitOrphans(from)
    if (from < to) {
      const piece = escapeHtml(text.slice(from, to))
      const cover = coverAt(from, to)
      if (cover.length) {
        const titles = cover
          .map((a) => `${a.authorName}：${a.text.replace(/\n/g, ' ').slice(0, 120)}`)
          .join('&#10;')
        const ids = cover.map((a) => a.id).join(' ')
        bodyHtml += `<mark class="ann${cover.every((a) => a.resolved) ? ' resolved' : ''}" data-ann="${escapeHtml(ids)}" title="${titles}">${piece}</mark>`
      } else {
        bodyHtml += piece
      }
    }
    emitOrphans(to)
  }
  // 空行保留
  bodyHtml = bodyHtml
    .split('\n')
    .map((l) => l || '<span class="blank"></span>')
    .join('\n')

  let commentsHtml = ''
  if (input.variant === 'annotated' && anns.length) {
    const items = anns.map((a, i) => {
      const n = annMap.get(a.id)!
      void n
      const replies = a.replies
        .map(
          (r) =>
            `<div class="reply"><b>${escapeHtml(r.authorName)}</b>：${escapeHtml(r.text)}<time>${fmtTime(r.createdAt)}</time></div>`,
        )
        .join('')
      return (
        `<section class="comment ${a.resolved ? 'resolved' : ''}" id="ann-${escapeHtml(a.id)}">` +
        `<h4>${markOf(i)} ${a.resolved ? '<span class="badge ok">已解决</span>' : ''}` +
        `${escapeHtml(a.authorName)}<time>${fmtTime(a.createdAt)}</time></h4>` +
        `<blockquote>${escapeHtml(a.quote || '（锚点原文已删除）')}</blockquote>` +
        `<p>${escapeHtml(a.text).replace(/\n/g, '<br>')}</p>${replies}</section>`
      )
    })
    commentsHtml = `<aside class="comments"><h2>批注（${anns.length}）</h2>${items.join('')}</aside>`
  }

  const banner =
    input.variant === 'history'
      ? `<div class="banner">📜 历史版本导出 · 文档 ${escapeHtml(input.docId)} · 修订 v${input.revision} · ${fmtTime(input.exportedAt)}</div>`
      : ''

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.docId)}${input.variant === 'annotated' ? '（带批注）' : ''}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; background: #f5f6f8; color: #1f2329;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', '微软雅黑', 'Source Han Sans SC', 'Noto Sans CJK SC', SimSun, '宋体', sans-serif; }
.page { max-width: 860px; margin: 32px auto; background: #fff; padding: 48px 56px;
  border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
.banner { background: #ecf5ff; border: 1px solid #b3d8ff; color: #1d6dc4; padding: 10px 16px;
  border-radius: 6px; margin-bottom: 24px; font-size: 14px; }
.doc { white-space: pre-wrap; word-break: break-word; line-height: 1.9; font-size: 15px; }
.blank { display: block; height: 1em; }
mark.ann { background: #fff3c4; padding: 0 1px; border-radius: 2px; cursor: help; }
mark.ann.resolved { background: #e8f5e9; }
sup.orphan a { text-decoration: none; background: #fef0f0; color: #f56c6c; border-radius: 8px; padding: 0 4px; }
.comments { margin-top: 48px; border-top: 2px solid #ebeef5; padding-top: 16px; }
.comment { border: 1px solid #ebeef5; border-radius: 8px; padding: 12px 16px; margin: 12px 0; background: #fafbfc; }
.comment.resolved { background: #f6fbf7; border-color: #e2efe4; }
.comment h4 { margin: 0 0 6px; font-size: 14px; }
.comment time, .reply time { float: right; color: #909399; font-size: 12px; font-weight: normal; }
.comment blockquote { margin: 6px 0; padding: 6px 10px; border-left: 3px solid #ffd666;
  background: #fffdf2; color: #615420; font-size: 13px; white-space: pre-wrap; }
.comment p { margin: 6px 0; font-size: 14px; }
.reply { margin: 6px 0 0 16px; font-size: 13px; color: #444; }
.badge.ok { background: #e8f5e9; color: #529b2e; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
</style>
</head>
<body><main class="page">${banner}<article class="doc">${bodyHtml}</article>${commentsHtml}</main></body></html>`
  return Buffer.from(html, 'utf8')
}

export function exportDocument(input: ExportInput): ExportFile {
  const base = input.docId.replace(/[^\w一-龥.-]+/g, '_')
  const suffix =
    input.variant === 'history' ? `-v${input.revision}` : input.variant === 'annotated' ? '-批注版' : ''
  const ext = input.format
  const fileName = `${base}${suffix}.${ext}`

  switch (input.format) {
    case 'txt':
      return { fileName, contentType: 'text/plain; charset=utf-8', data: exportTxt(input) }
    case 'md':
      return { fileName, contentType: 'text/markdown; charset=utf-8', data: exportMd(input) }
    case 'html':
      return { fileName, contentType: 'text/html; charset=utf-8', data: exportHtml(input) }
    case 'docx':
      return {
        fileName,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: buildDocx(input.text, {
          annotated: input.variant === 'annotated',
          annotations: input.annotations,
        }),
      }
  }
}
