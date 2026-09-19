/**
 * 导出 .docx（OOXML）。
 *
 * - 中文字体：docDefaults 与每个 run 均声明 eastAsia（宋体），避免非中文环境导出后回退异常；
 * - 链接：正文中的 [文字](url) 转为真正的 w:hyperlink 关系；
 * - 批注锚点：带批注导出时，在批注区间边界切分 run，插入 commentRangeStart/End，
 *   覆盖区域黄色高亮并在区间末尾上标编号；孤儿批注锚定到 📌 独立 run；
 * - 批注内容写入 word/comments.xml（正文 + 回复串 + 解决状态）；
 * - Markdown 标题行（# …）转为加粗加大字号段落。
 */
import { ZipWriter } from './zipWriter'
import type { Annotation } from '../../../shared/protocol'

interface LinkSeg {
  start: number
  end: number
  label: string
  href: string
}

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 解析一行中的链接段（括号内为显示文本，偏移按原始语法计） */
function linkSegments(line: string): LinkSeg[] {
  const segs: LinkSeg[] = []
  let m: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(line))) {
    segs.push({ start: m.index, end: m.index + m[0].length, label: m[1], href: m[2] })
  }
  return segs
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
const markOf = (i: number) => CIRCLED[i] ?? `［${i + 1}］`

export interface DocxExportOptions {
  annotated: boolean
  annotations: Annotation[]
}

export function buildDocx(text: string, opts: DocxExportOptions): Buffer {
  const anns = opts.annotated ? opts.annotations : []
  const numbered = anns.map((ann, i) => ({ ann, no: i, mark: markOf(i) }))
  const annById = new Map(numbered.map((n) => [n.ann.id, n]))

  // 行起点全局偏移
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const rawLines = text.split('\n')

  // 超链接关系
  const rels = new Map<string, string>()
  let hyperSeq = 100
  const hrefRid = (href: string) => {
    let id = rels.get(href)
    if (!id) {
      id = `rId${hyperSeq++}`
      rels.set(href, id)
    }
    return id
  }

  const commentStarts = new Map<number, string[]>()
  const commentEnds = new Map<number, string[]>()
  const orphanAt = new Map<number, string[]>()
  for (const a of anns) {
    if (a.orphan || a.start === a.end) {
      const list = orphanAt.get(a.start) ?? []
      list.push(a.id)
      orphanAt.set(a.start, list)
    } else {
      const s = Math.min(a.start, text.length)
      const e = Math.min(a.end, text.length)
      ;(commentStarts.get(s) ?? commentStarts.set(s, []).get(s)!).push(a.id)
      ;(commentEnds.get(e) ?? commentEnds.set(e, []).get(e)!).push(a.id)
    }
  }

  const runPropsXml = (highlight: boolean, headingLevel: number) => {
    const parts = ['<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Times New Roman"/>']
    if (headingLevel > 0) {
      parts.push('<w:b/>')
      parts.push(`<w:sz w:val="${Math.max(24, 36 - (headingLevel - 1) * 4)}"/>`)
      parts.push('<w:color w:val="1F2937"/>')
    }
    if (highlight) parts.push('<w:highlight w:val="yellow"/>')
    return `<w:rPr>${parts.join('')}</w:rPr>`
  }

  const startTags = (globalOff: number) =>
    (commentStarts.get(globalOff) ?? [])
      .map((id) => `<w:commentRangeStart w:id="${annById.get(id)!.no}"/>`)
      .join('')
  const endTags = (globalOff: number) =>
    (commentEnds.get(globalOff) ?? [])
      .map((id) => {
        const no = annById.get(id)!.no
        const mark = annById.get(id)!.mark
        return (
          `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${mark}</w:t></w:r>` +
          `<w:commentRangeEnd w:id="${no}"/>` +
          `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${no}"/></w:r>`
        )
      })
      .join('')

  const orphanTags = (globalOff: number) =>
    (orphanAt.get(globalOff) ?? [])
      .map((id) => {
        const n = annById.get(id)!
        return (
          `<w:commentRangeStart w:id="${n.no}"/>` +
          `<w:r>${runPropsXml(true, 0)}<w:t>📌${n.mark}</w:t></w:r>` +
          `<w:commentRangeEnd w:id="${n.no}"/>` +
          `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${n.no}"/></w:r>`
        )
      })
      .join('')

  const covering = (from: number, to: number) =>
    anns.filter((a) => !a.orphan && a.start < to && a.end > from)

  const bodyParts: string[] = []

  rawLines.forEach((rawLine, li) => {
    const lineStart = lineStarts[li]
    let line = rawLine
    let headingLevel = 0
    const hm = line.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      headingLevel = hm[1].length
      line = hm[2]
    }
    const links = linkSegments(line)

    // 该行所有切点：行首尾 + 批注边界 + 链接边界（均落在本行 [0, line.length]）
    const bounds = new Set<number>([0, line.length])
    for (const a of anns) {
      if (a.orphan) continue
      const s = a.start - lineStart
      const e = a.end - lineStart
      if (s > 0 && s < line.length) bounds.add(s)
      if (e > 0 && e < line.length) bounds.add(e)
    }
    for (const l of links) {
      bounds.add(l.start)
      bounds.add(l.end)
    }
    const pts = [...bounds].filter((p) => p >= 0 && p <= line.length).sort((a, b) => a - b)

    let content = startTags(lineStart)
    for (let k = 0; k < pts.length - 1; k++) {
      const from = pts[k]
      const to = pts[k + 1]
      const gFrom = lineStart + from
      const gTo = lineStart + to

      // 该切点的结束/孤儿/开始标签（顺序：结束引用 → 孤儿 → 新区间开始）
      content += endTags(gFrom)
      content += orphanTags(gFrom)
      content += startTags(gFrom)
      if (from === to) continue

      const piece = line.slice(from, to)
      const link = links.find((l) => l.start <= from && l.end >= to)
      // 批注边界可能落在链接语法内部：显示文本仅对应语法中的 label 部分（'[' 之后）
      let visible = piece
      if (link) {
        const labelFrom = link.start + 1
        const labelTo = labelFrom + link.label.length
        const oFrom = Math.max(from, labelFrom)
        const oTo = Math.min(to, labelTo)
        visible = oFrom < oTo ? link.label.slice(oFrom - labelFrom, oTo - labelFrom) : ''
      }
      const cover = covering(gFrom, gTo)
      const rPr = runPropsXml(cover.length > 0, headingLevel)
      if (visible !== '') {
        const run = `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(visible)}</w:t></w:r>`
        content += link
          ? `<w:hyperlink r:id="${hrefRid(link.href)}" w:history="1">${run}</w:hyperlink>`
          : run
      }
    }
    // 行末
    const gEnd = lineStart + line.length
    content += endTags(gEnd)
    content += orphanTags(gEnd)

    const pPr =
      headingLevel > 0
        ? `<w:pPr><w:pStyle w:val="Heading${headingLevel}"/><w:spacing w:before="160" w:after="80"/></w:pPr>`
        : ''
    bodyParts.push(`<w:p>${pPr}${content}</w:p>`)
  })

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${bodyParts.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`

  /* ---------------- comments.xml ---------------- */

  let commentsXml = ''
  if (anns.length) {
    const commentParts = numbered.map((n) => {
      const a = n.ann
      const paras: string[] = []
      const addPara = (t: string, bold = false) =>
        `<w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:rFonts w:eastAsia="宋体"/></w:rPr>` +
        `<w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r></w:p>`
      paras.push(addPara(`${a.resolved ? '【已解决】' : ''}${a.authorName}：${a.text}`))
      for (const rep of a.replies) paras.push(addPara(`└ ${rep.authorName}：${rep.text}`))
      if (a.orphan) paras.push(addPara('（原文锚点已被删除，批注为孤儿状态）'))
      return (
        `<w:comment w:id="${n.no}" w:author="${xmlEscape(a.authorName)}" ` +
        `w:date="${new Date(a.createdAt).toISOString()}" w:initials="${xmlEscape(a.authorName.slice(0, 1))}">` +
        paras.join('') +
        `</w:comment>`
      )
    })
    commentsXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      commentParts.join('') +
      `</w:comments>`
  }

  /* ---------------- 包结构 ---------------- */

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Times New Roman"/>` +
    `<w:sz w:val="22"/><w:szCs w:val="22"/>` +
    `</w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `</w:styles>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    (anns.length
      ? `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`
      : '') +
    `</Types>`

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  const docRelParts = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  ]
  if (anns.length) {
    docRelParts.push(
      `<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`,
    )
  }
  for (const [href, id] of rels) {
    docRelParts.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(href)}" TargetMode="External"/>`,
    )
  }
  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    docRelParts.join('') +
    `</Relationships>`

  const zip = new ZipWriter()
  zip.addFile('[Content_Types].xml', contentTypes)
  zip.addFile('_rels/.rels', rootRels)
  zip.addFile('word/_rels/document.xml.rels', docRels)
  zip.addFile('word/document.xml', documentXml)
  zip.addFile('word/styles.xml', stylesXml)
  if (anns.length) zip.addFile('word/comments.xml', commentsXml)
  return zip.buffer()
}
