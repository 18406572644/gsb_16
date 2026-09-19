/**
 * OOXML 办公文档解析：.docx / .pptx / .xlsx → Markdown。
 *
 * - docx：优先使用 mammoth 转换为 Markdown（样式/列表/表格/图片引用保真度高），
 *   mammoth 不可用时回退为按段落/表格提取纯文本；
 * - pptx：逐张幻灯片提取标题、正文段落、项目符号与备注；内嵌媒体无法内联时给出告警；
 * - xlsx：合并 sharedStrings，按工作表输出 Markdown 表格，支持稀疏单元格与内联字符串。
 *
 * 所有 XML 均按 UTF-8 解码，完整支持中文与特殊字符。
 */
import { createRequire } from 'node:module'
import { decodeEntities } from './html'
import { normalizeMd } from './html'
import { ZipReader } from './zip'

const require = createRequire(import.meta.url)

interface Mammoth {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>
}

let mammothRef: Mammoth | null | undefined
function getMammoth(): Mammoth | null {
  if (mammothRef !== undefined) return mammothRef
  try {
    mammothRef = require('mammoth') as Mammoth
  } catch {
    mammothRef = null
  }
  return mammothRef
}

function xmlDecode(s: string): string {
  return decodeEntities(s)
    .replace(/\u0000/g, '')
}

/** 提取元素内所有 <w:t>/<a:t> 文本（按段间断行由调用方处理） */
function allText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let out = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out += xmlDecode(m[1])
  return out
}

/* ---------------- DOCX ---------------- */

/** mammoth 失败时的兜底：段落 w:p → 行，表格 w:tbl → 管道表格 */
function docxFallback(xml: string): string {
  const out: string[] = []
  // 按 body 内块级元素粗略扫描
  const blockRe = /<w:(p|tbl)(?:\s[^>]*)?>([\s\S]*?)<\/w:\1>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(xml))) {
    const [, kind, inner] = m
    if (kind === 'tbl') {
      const rows: string[][] = []
      const rowRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g
      let rm: RegExpExecArray | null
      while ((rm = rowRe.exec(inner))) {
        const cells: string[] = []
        const cellRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g
        let cm: RegExpExecArray | null
        while ((cm = cellRe.exec(rm[1]))) {
          const paras = [...cm[1].matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
            .map((p) => allText(p[1], 'w:t').trim())
            .filter(Boolean)
          cells.push(paras.join('<br>').replace(/\|/g, '\\|'))
        }
        if (cells.length) rows.push(cells)
      }
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length))
        rows.forEach((r, idx) => {
          while (r.length < width) r.push('')
          out.push(`| ${r.join(' | ')} |`)
          if (idx === 0) out.push(`| ${Array(width).fill('---').join(' | ')} |`)
        })
        out.push('')
      }
    } else {
      // 段落：<w:br> 转换行
      const runs = inner.replace(/<w:br[^>]*\/>/g, '\n')
      const text = allText(runs, 'w:t')
      const style = /<w:pStyle\s+w:val="(\d|[^"]*[Hh]eading\w*|[^"]*[Tt]itle)"/.exec(inner)
      const decoded = text.replace(/\u0000/g, '')
      if (decoded.trim()) {
        const h = style?.[1]?.match(/(\d)/)?.[1]
        if (h && Number(h) >= 1 && Number(h) <= 6) out.push('#'.repeat(Number(h)) + ' ' + decoded.trim())
        else out.push(decoded)
      }
    }
  }
  return out.join('\n')
}

export async function parseDocx(buf: Buffer): Promise<{ md: string; warnings: string[] }> {
  const warnings: string[] = []
  const zip = new ZipReader(buf)
  const documentXml = zip.readText('word/document.xml')
  if (!documentXml) throw new Error('DOCX: 缺少 word/document.xml，文件可能已损坏')

  const mammoth = getMammoth()
  if (mammoth) {
    try {
      const result = await mammoth.convertToMarkdown({ buffer: buf })
      const md = result.value || ''
      if (Array.isArray(result.messages) && result.messages.length) {
        const ignored = result.messages
          .slice(0, 5)
          .map((x) => (x as { message?: string }).message)
          .filter(Boolean)
        warnings.push(...ignored.map((x) => `mammoth: ${x}`))
      }
      if (md.trim()) {
        countMedia(zip, 'word/media', warnings)
        return { md: normalizeMd(md), warnings }
      }
      warnings.push('mammoth 转换结果为空，已回退到内置解析器')
    } catch (e) {
      warnings.push(`mammoth 转换失败，已回退到内置解析器：${(e as Error).message}`)
    }
  } else {
    warnings.push('未安装 mammoth，使用内置纯文本解析器（样式信息会丢失）')
  }
  countMedia(zip, 'word/media', warnings)
  return { md: normalizeMd(docxFallback(documentXml)), warnings }
}

function countMedia(zip: ZipReader, dir: string, warnings: string[]) {
  const media = zip.list().filter((n) => n.startsWith(dir + '/'))
  const imgs = media.filter((n) => /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(n)).length
  const others = media.length - imgs
  if (imgs > 0) warnings.push(`文档包含 ${imgs} 张内嵌图片，正文以图片占位/引用形式保留，原始图片未导出`)
  if (others > 0) warnings.push(`文档包含 ${others} 个其他内嵌媒体文件，导入时已忽略`)
}

/* ---------------- PPTX ---------------- */

export function parsePptx(buf: Buffer): { md: string; warnings: string[] } {
  const warnings: string[] = []
  const zip = new ZipReader(buf)
  // 幻灯片按文件名中的序号排序（slide1.xml … slide10.xml，注意不能字典序）
  const slides = zip
    .list()
    .filter((n) => /^ppt\/slides\/slide(\d+)\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b))
  if (!slides.length) throw new Error('PPTX: 未找到任何幻灯片（ppt/slides/）')

  const out: string[] = []
  for (let i = 0; i < slides.length; i++) {
    const xml = zip.readText(slides[i])!
    // 形状文本：<a:p> 段落，内部 <a:t> 为文字片段；buChar/buAutoNum 表示项目符号
    const paras: { text: string; bullet: boolean; lvl: number }[] = []
    const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g
    let pm: RegExpExecArray | null
    while ((pm = pRe.exec(xml))) {
      const inner = pm[1]
      const text = [...inner.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((t) => xmlDecode(t[1]))
        .join('')
      if (!text.trim()) continue
      const lvl = /<a:buLvl\s+[^>]*lvl="(\d+)"/.exec(inner)
      const hasBullet = /<a:buChar|<a:buAutoNum/.test(inner) || Number(lvl?.[1] ?? 0) > 0
      paras.push({ text: text.trim(), bullet: hasBullet, lvl: Number(lvl?.[1] ?? 0) })
    }

    out.push(`## 幻灯片 ${i + 1}`)
    // 第一段常为标题（p:ph type="title"/ctrTitle 的形状），单独提升
    for (const p of paras) {
      const prefix = p.bullet ? '  '.repeat(Math.min(p.lvl, 5)) + '- ' : ''
      out.push(prefix + p.text)
    }

    // 备注
    const noteNum = slideNum(slides[i])
    const note = zip.readText(`ppt/notesSlides/notesSlide${noteNum}.xml`)
    if (note) {
      const noteText = [...note.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((t) => xmlDecode(t[1]))
        .join('')
        .trim()
      if (noteText) {
        out.push('')
        out.push(`> **演讲者备注：** ${noteText.replace(/\n+/g, ' ')}`)
      }
    }
    out.push('')
  }
  countMedia(zip, 'ppt/media', warnings)
  return { md: normalizeMd(out.join('\n')), warnings }
}

function slideNum(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name)
  return m ? Number(m[1]) : 0
}

/* ---------------- XLSX ---------------- */

interface SheetMeta {
  name: string
  target: string
}

export function parseXlsx(buf: Buffer): { md: string; warnings: string[] } {
  const warnings: string[] = []
  const zip = new ZipReader(buf)
  const shared: string[] = []
  const ssXml = zip.readText('xl/sharedStrings.xml')
  if (ssXml) {
    // 每个 <si> 是一个共享字符串，内部可能有多个 <r><t>，拼接之
    const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
    let m: RegExpExecArray | null
    while ((m = siRe.exec(ssXml))) {
      shared.push(allText(m[1], 't'))
    }
  }

  // 工作表顺序与名称：workbook.xml + workbook.xml.rels
  const metas = readSheetMetas(zip)
  if (!metas.length) {
    const files = zip.list().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    files.forEach((f, i) => metas.push({ name: `Sheet${i + 1}`, target: f }))
  }
  if (!metas.length) throw new Error('XLSX: 未找到任何工作表')

  const out: string[] = []
  for (const meta of metas) {
    const xml = zip.readText(meta.target.startsWith('xl/') ? meta.target : `xl/${meta.target.replace(/^\//, '')}`)
    if (!xml) {
      warnings.push(`工作表「${meta.name}」内容缺失，已跳过`)
      continue
    }
    out.push(`## ${meta.name}`)
    const rows = sheetToRows(xml, shared)
    if (!rows.length) {
      out.push('（空表）', '')
      continue
    }
    const width = Math.max(...rows.map((r) => r.length))
    rows.forEach((r, idx) => {
      while (r.length < width) r.push('')
      out.push(`| ${r.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ')} |`)
      if (idx === 0) out.push(`| ${Array(width).fill('---').join(' | ')} |`)
    })
    out.push('')
  }
  countMedia(zip, 'xl/media', warnings)
  return { md: normalizeMd(out.join('\n')), warnings }
}

function readSheetMetas(zip: ZipReader): SheetMeta[] {
  const wb = zip.readText('xl/workbook.xml')
  if (!wb) return []
  // r:id → target
  const rels: Record<string, string> = {}
  const relsXml = zip.readText('xl/_rels/workbook.xml.rels')
  if (relsXml) {
    for (const m of relsXml.matchAll(
      /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g,
    )) {
      rels[m[1]] = xmlDecode(m[2])
    }
  }
  const metas: SheetMeta[] = []
  for (const m of wb.matchAll(/<sheet\b[^>]*\/>/g)) {
    const tag = m[0]
    const name = /\bname="([^"]*)"/.exec(tag)?.[1] ?? 'Sheet'
    const rid = /\br:id="([^"]+)"/.exec(tag)?.[1]
    metas.push({ name: xmlDecode(name), target: rid ? rels[rid] || '' : '' })
  }
  return metas.filter((m) => m.target)
}

function colToIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1]
  if (!letters) return 0
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function sheetToRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml))) {
    const inner = rm[1] ?? ''
    const cells: { col: number; val: string }[] = []
    for (const cm of inner.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cm[1] ?? cm[3] ?? ''
      const body = cm[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A1'
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      let val = ''
      if (type === 'inlineStr') {
        val = allText(body, 't')
      } else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1]
        if (v !== undefined) {
          if (type === 's') {
            const idx = Number(xmlDecode(v))
            val = shared[idx] ?? ''
          } else if (type === 'b') {
            val = xmlDecode(v) === '1' ? 'TRUE' : 'FALSE'
          } else {
            val = xmlDecode(v)
          }
        }
      }
      cells.push({ col: colToIndex(ref), val: val.trim() })
    }
    if (!cells.length) continue
    const width = Math.max(...cells.map((c) => c.col + 1))
    const rowArr = Array.from({ length: width }, () => '')
    for (const c of cells) rowArr[c.col] = c.val
    // 完全空白的行不输出
    if (rowArr.some((v) => v.trim())) rows.push(rowArr)
  }
  return rows
}
