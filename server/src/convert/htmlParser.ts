/**
 * 极简 HTML → 纯文本转换（服务端无 DOM 环境，自写扫描器）。
 *
 * 兼容处理：
 * - 块级标签（p/div/h1-6/li/tr/blockquote/pre/section…）产生换行；
 * - 链接保留为 Markdown 形态 [文字](地址)，信息不丢失（导出 md/html 可还原）；
 * - 图片输出占位 [图片：alt](src)，统计数量；data: 内嵌图只保留 alt；
 * - script/style/noscript/template 整体丢弃并计数警告；
 * - 表格行转换为文本行，单元格以 " | " 分隔；列表项加 "- " 前缀；
 * - 命名实体与数字实体解码；折叠标签间多余空白（pre 除外）。
 */
import type { ConvertWarning } from '../../../shared/transfer'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  deg: '°',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(cp) || cp <= 0) return m
      try {
        return String.fromCodePoint(cp)
      } catch {
        return m
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m
  })
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'dl', 'dt', 'dd', 'figure',
  'figcaption', 'hr', 'form', 'fieldset', 'address', 'details', 'summary',
])
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

export interface HtmlParseResult {
  text: string
  links: number
  images: number
  warnings: ConvertWarning[]
}

interface Anchor {
  href: string
  text: string
}

export function htmlToText(html: string): HtmlParseResult {
  const warnings: ConvertWarning[] = []
  let out = ''
  let droppedBlocks = 0
  let links = 0
  let images = 0

  // 文档级空白折叠状态
  const stack: { tag: string; pre: boolean; inList: boolean; liIndex?: number[] }[] = []
  let inPre = false
  // 丢弃内容的标签栈（script/style 等）
  let dropDepth = 0
  // 当前正在收集的链接
  let anchor: Anchor | null = null

  const ensureNewline = () => {
    if (out.length === 0) return
    if (!out.endsWith('\n')) out += '\n'
  }
  const appendText = (t: string) => {
    if (!t) return
    if (anchor) anchor.text += t
    if (inPre) {
      out += t
    } else {
      // 折叠连续空白（含换行/制表符）为单个空格
      const collapsed = t.replace(/[ \t\r\n\f]+/g, ' ')
      // 行首空格去除
      if (collapsed === ' ' && (out === '' || out.endsWith('\n') || out.endsWith(' '))) return
      out += collapsed
    }
  }

  const tokenRe = /(<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[a-zA-Z][^>]*?>)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(html))) {
    if (m.index > last && dropDepth === 0) appendText(decodeEntities(html.slice(last, m.index)))
    last = tokenRe.lastIndex
    const tok = m[0]

    if (tok.startsWith('<!--') || /^<!/i.test(tok)) continue

    const isClose = tok[1] === '/'
    const tagBody = isClose ? tok.slice(2, -1) : tok.slice(1, -1)
    const selfClose = tagBody.endsWith('/')
    const tagName = (tagBody.split(/[\s/>]/)[0] || '').toLowerCase()
    if (!tagName) continue
    const attrText = tagBody.slice(tagName.length)
    const attr = (name: string): string | null => {
      const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i')
      const hit = attrText.match(re)
      return hit ? decodeEntities(hit[1] ?? hit[2] ?? hit[3] ?? '') : null
    }

    if (isClose) {
      if (DROP_TAGS.has(tagName)) {
        if (dropDepth > 0) dropDepth--
        continue
      }
      if (dropDepth > 0) continue
      if (tagName === 'a' && anchor) {
        const { href, text } = anchor
        anchor = null
        const label = text.trim()
        if (href && /^(https?:|mailto:|ftp:)/i.test(href) && label && label !== href) {
          appendText(`[${label}](${href})`)
          links++
        } else {
          appendText(label)
        }
      } else if (BLOCK_TAGS.has(tagName)) {
        ensureNewline()
      }
      const top = stack[stack.length - 1]
      if (top && top.tag === tagName) {
        stack.pop()
        inPre = stack.some((s) => s.pre)
      }
      continue
    }

    if (DROP_TAGS.has(tagName)) {
      dropDepth++
      droppedBlocks++
      continue
    }
    if (dropDepth > 0) continue

    if (BLOCK_TAGS.has(tagName)) {
      ensureNewline()
      if (tagName === 'li') out += '- '
      if (tagName === 'tr') {
        // 行首若刚写过 "- " 不影响；单元格分隔在 td/th 关闭时处理
      }
      if (tagName === 'hr') out += '---'
      if (HEADING_TAGS.has(tagName)) out += '## '
      stack.push({ tag: tagName, pre: tagName === 'pre', inList: tagName === 'ul' || tagName === 'ol' })
      inPre = inPre || tagName === 'pre'
    } else if (tagName === 'a') {
      const href = attr('href')
      anchor = href ? { href, text: '' } : null
    } else if (tagName === 'br') {
      out += '\n'
    } else if (tagName === 'img') {
      images++
      const alt = (attr('alt') || '').trim()
      const src = (attr('src') || '').trim()
      if (src && !src.startsWith('data:')) {
        appendText(`[图片：${alt || '无说明'}](${src})`)
      } else {
        appendText(`[图片：${alt || '内嵌图片已转为占位'}]`)
      }
    } else if (tagName === 'td' || tagName === 'th') {
      if (!out.endsWith('\n') && !out.endsWith('| ') && out.length > 0) out += ' | '
    }

    // 自闭合的块级元素不入栈
    if (selfClose && BLOCK_TAGS.has(tagName)) {
      ensureNewline()
      stack.pop()
    } else if (selfClose) {
      // void 元素
    } else if (!BLOCK_TAGS.has(tagName) && tagName !== 'a') {
      // 行内元素无需跟踪
    }
  }
  if (last < html.length && dropDepth === 0) appendText(decodeEntities(html.slice(last)))

  if (droppedBlocks > 0) {
    warnings.push({ code: 'STYLE_DROPPED', message: `已忽略 ${droppedBlocks} 段 script/style 等非正文内容`, count: droppedBlocks })
  }

  // 规整：每行 trim 尾部空白，压缩 3+ 连续空行为 2 个
  let text = out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t\n]+/, '')
    .replace(/[ \t\n]+$/, '')

  if (!text.endsWith('\n')) text += '\n'

  return { text, links, images, warnings }
}
