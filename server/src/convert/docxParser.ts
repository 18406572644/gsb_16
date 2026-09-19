/**
 * .docx（OOXML）→ 纯文本提取。
 *
 * docx 是 zip 包：
 *   word/document.xml            正文
 *   word/_rels/document.xml.rels 关系（超链接 Target、图片媒体）
 *   word/comments.xml            批注（纯文本模型无法自动锚定，仅计数并警告）
 *
 * 保留信息：段落 / 标题（转为 # 前缀）/ 列表项（- 前缀）/ 表格单元格（| 分隔）/
 * 超链接（转为 [文字](url)）/ 图片占位。字体、字号、颜色等样式不进入纯文本模型。
 */
import type { ConvertWarning } from '../../../shared/transfer'
import { readZip } from './zipReader'
import { decodeEntities } from './htmlParser'
import { FatalConvertError } from '../tasks/errors'

export interface DocxParseResult {
  text: string
  links: number
  images: number
  comments: number
  warnings: ConvertWarning[]
}

interface Run {
  text: string
  href?: string
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b(?:[\\w]+:)?${name}\\s*=\\s*"([^"]*)"`, 'i')
  const hit = tag.match(re)
  return hit ? hit[1] : null
}

/** 解析 document.xml.rels：rId → 外部超链接 URL / 内部媒体路径 */
function parseRels(xml: string): Map<string, { target: string; external: boolean }> {
  const map = new Map<string, { target: string; external: boolean }>()
  const re = /<Relationship\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const tag = m[0]
    const id = attr(tag, 'Id')
    const target = attr(tag, 'Target')
    const mode = attr(tag, 'TargetMode')
    if (id && target) map.set(id, { target, external: mode === 'External' })
  }
  return map
}

function countComments(xml: string | undefined): number {
  if (!xml) return 0
  const m = xml.match(/<w:comment\b/gi)
  return m ? m.length : 0
}

export function docxToText(buf: Buffer): DocxParseResult {
  const warnings: ConvertWarning[] = []
  let zip: Map<string, Buffer>
  try {
    zip = readZip(buf)
  } catch (e) {
    throw new FatalConvertError(
      `无法读取 docx 压缩包：${e instanceof Error ? e.message : '文件损坏'}（老式 .doc 请先另存为 .docx）`,
      'INVALID_DOCX',
    )
  }

  const docXml = zip.get('word/document.xml')
  if (!docXml) {
    throw new FatalConvertError(
      'DOCX: 包内缺少 word/document.xml（文件可能损坏，或是老式 .doc 格式，请另存为 .docx）',
      'INVALID_DOCX',
    )
  }
  const rels = parseRels(zip.get('word/_rels/document.xml.rels')?.toString('utf8') ?? '')
  const comments = countComments(zip.get('word/comments.xml')?.toString('utf8'))

  const xml = docXml.toString('utf8')
  const lines: string[] = []

  // 当前段落状态
  let para: Run[] = []
  let heading = 0
  let isList = false
  let inT = false
  let tSpace = false
  const linkStack: (string | null)[] = []
  let inDrawing = 0
  let blipInPara = 0

  const flushParagraph = () => {
    let line = para
      .map((r) => (r.href ? `[${r.text}](${r.href})` : r.text))
      .join('')
    // 表格单元格分隔符收尾清理
    line = line.replace(/\s*\|\s*$/, '').replace(/\t+/g, ' ').replace(/[ ]{2,}/g, ' ').trim()
    if (line) {
      if (heading > 0) line = `${'#'.repeat(Math.min(6, heading))} ${line}`
      else if (isList) line = `- ${line}`
    }
    lines.push(line)
    para = []
    heading = 0
    isList = false
    blipInPara = 0
  }

  const pushText = (raw: string) => {
    let text = decodeEntities(raw)
    if (!tSpace) text = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
    if (!text) return
    const rid = linkStack[linkStack.length - 1] ?? null
    const rel = rid ? rels.get(rid) : undefined
    para.push({ text, href: rel?.external ? rel.target : undefined })
  }

  const tokenRe = /<[^>]+>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(xml))) {
    if (inT && m.index > last) pushText(xml.slice(last, m.index))
    last = tokenRe.lastIndex
    const tag = m[0]

    if (/^<w:t\b/i.test(tag)) {
      inT = true
      tSpace = attr(tag, 'space') === 'preserve'
      continue
    }
    if (/^<\/w:t\s*>/i.test(tag)) {
      inT = false
      continue
    }
    if (inT) continue

    if (/^<w:p\s*\/?>/i.test(tag)) {
      para = []
      heading = 0
      isList = false
    } else if (/^<\/w:p\s*>/i.test(tag)) {
      flushParagraph()
    } else if (/^<w:pStyle\b/i.test(tag)) {
      const v = (attr(tag, 'val') || '').toLowerCase()
      const hm = v.match(/heading\s*([1-6])/)
      if (hm) heading = Number(hm[1])
    } else if (/^<w:numPr\b/i.test(tag)) {
      isList = true
    } else if (/^<w:hyperlink\b/i.test(tag)) {
      linkStack.push(attr(tag, 'id'))
    } else if (/^<\/w:hyperlink\s*>/i.test(tag)) {
      linkStack.pop()
    } else if (/^<w:drawing\b/i.test(tag) || /^<w:pict\b/i.test(tag)) {
      inDrawing++
    } else if (/^<\/w:drawing\s*>/i.test(tag) || /^<\/w:pict\s*>/i.test(tag)) {
      inDrawing = Math.max(0, inDrawing - 1)
    } else if (inDrawing > 0 && /<a:blip\b/i.test(tag)) {
      blipInPara++
      const rid = attr(tag, 'embed') || attr(tag, 'link')
      const rel = rid ? rels.get(rid) : undefined
      const name = rel && !rel.external ? rel.target.replace(/^.*\//, '') : '图片'
      para.push({ text: `[图片：${name}]` })
    } else if (/^<w:tab\b/i.test(tag)) {
      para.push({ text: '\t' })
    } else if (/^<w:br\b/i.test(tag) || /^<w:cr\b/i.test(tag)) {
      // 段内换行：结束当前行并开启同段落的新行（样式不延续到续行）
      let line = para.map((r) => (r.href ? `[${r.text}](${r.href})` : r.text)).join('').trim()
      lines.push(line)
      para = []
    } else if (/^<\/w:tc\s*>/i.test(tag)) {
      para.push({ text: '\t| ' })
    }
  }

  let links = 0
  for (const l of lines) {
    links += (l.match(/\]\((?:https?|mailto|ftp):[^)]+\)/g) || []).length
  }
  const images = blipInPara > 0 ? blipInPara : 0
  const totalImages = (xml.match(/<a:blip\b/gi) || []).length

  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  if (!text.endsWith('\n')) text += '\n'

  if (totalImages > 0) {
    warnings.push({
      code: 'IMAGE_PLACEHOLDER',
      message: `文档包含 ${totalImages} 张图片，已替换为文字占位（纯文本模型不内嵌图片）`,
      count: totalImages,
    })
  }
  if (comments > 0) {
    warnings.push({
      code: 'COMMENT_DROPPED',
      message: `原 Word 文档含 ${comments} 条批注，无法自动锚定到当前编辑器，已丢弃（可在确认导入后重新批注）`,
      count: comments,
    })
  }
  warnings.push({
    code: 'STYLE_DROPPED',
    message: '字体、字号、颜色、页眉页脚等排版样式未导入（仅保留正文结构与链接）',
  })

  return { text, links, images: totalImages, comments, warnings }
}
