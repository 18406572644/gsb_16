/**
 * 轻量 HTML ⇄ Markdown 转换（零第三方依赖）。
 *
 * 设计取向：
 * - 完整保留 Unicode（含中文）与特殊字符，不做有损转义；
 * - 链接 / 图片的 URL 原样保留（含相对路径与 data: URI）；
 * - 支持标题、段落、列表（含嵌套）、引用、代码块、表格、加粗/斜体、换行；
 * - 跳过 script/style/head 等非正文内容，解码常见 HTML 实体。
 */

/* ---------------- 实体解码 ---------------- */

const ENTITIES: Record<string, string> = {
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
  times: '×',
  divide: '÷',
  middot: '·',
  laquo: '«',
  raquo: '»',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(cp) && cp > 0) {
        try {
          return String.fromCodePoint(cp)
        } catch {
          return m
        }
      }
      return m
    }
    return ENTITIES[body] ?? m
  })
}

function escapeAttr(s: string): string {
  return decodeEntities(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/* ---------------- HTML 解析为 DOM 树 ---------------- */

interface HtmlNode {
  tag: string
  attrs: Record<string, string>
  children: (HtmlNode | string)[]
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 这些标签遇到同名或新的同类开启标签时自动关闭，容忍源 HTML 缺闭合 */
const AUTO_CLOSE = new Set(['li', 'dt', 'dd', 'p', 'td', 'th', 'tr', 'option', 'thead', 'tbody', 'tfoot'])

const TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g

export function parseHtml(html: string): (HtmlNode | string)[] {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [] }
  const stack: HtmlNode[] = [root]
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(html))) {
    const tok = m[0]
    if (tok.startsWith('<!--') || tok.startsWith('<!DOCTYPE') || tok.startsWith('<!doctype')) continue
    if (tok[0] !== '<') {
      const top = stack[stack.length - 1]
      // 分组：1=CDATA 内容，2=/?, 3=tag, 4=attrs, 5=自闭合斜杠, 6=文本
      top.children.push(m[6] ?? (m[1] !== undefined ? m[1] : ''))
      continue
    }
    const isClose = m[2] === '/'
    const tag = (m[3] || '').toLowerCase()
    if (!tag) continue
    if (!isClose) {
      const attrs = parseAttrs(m[4] || '')
      const selfClose = m[5] === '/' || VOID_TAGS.has(tag)
      // 自动关闭尚未闭合的同类/可嵌套边界标签
      if (AUTO_CLOSE.has(tag)) {
        for (let i = stack.length - 1; i >= 1; i--) {
          const t = stack[i].tag
          if (t === tag || (tag === 'td' || tag === 'th') && (t === 'td' || t === 'th')) {
            stack.length = i
            break
          }
          if (['table', 'ul', 'ol', 'section'].includes(t)) break
        }
      }
      const node: HtmlNode = { tag, attrs, children: [] }
      stack[stack.length - 1].children.push(node)
      if (!selfClose) stack.push(node)
    } else {
      // 闭合标签：弹到匹配项（容忍错误嵌套）
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
    }
  }
  return root.children
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? ''
  }
  return attrs
}

/* ---------------- HTML → Markdown ---------------- */

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript'])
const BLOCK_TAGS = new Set([
  'div', 'p', 'section', 'article', 'header', 'footer', 'main',
  'aside', 'blockquote', 'pre', 'table', 'ul', 'ol', 'dl', 'figure',
  'form', 'fieldset', 'address',
])

function nodeText(nodes: (HtmlNode | string)[]): string {
  let out = ''
  for (const c of nodes) {
    if (typeof c === 'string') out += c
    else out += nodeText(c.children)
  }
  return out
}

function trimLines(s: string): string {
  return s.replace(/^\n+/, '').replace(/[ \t]+\n/g, '\n').replace(/\n+$/, '')
}

function renderInline(nodes: (HtmlNode | string)[]): string {
  let out = ''
  for (const c of nodes) {
    if (typeof c === 'string') {
      out += decodeEntities(c)
      continue
    }
    switch (c.tag) {
      case 'br':
        out += '  \n'
        break
      case 'img': {
        const alt = (c.attrs.alt || '').trim()
        const src = c.attrs.src
        if (src) out += `![${alt}](${src}${c.attrs.title ? ` "${decodeEntities(c.attrs.title)}"` : ''})`
        break
      }
      case 'a': {
        const inner = trimLines(renderInline(c.children))
        const href = c.attrs.href || ''
        if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
          out += `[${inner}](${href}${c.attrs.title ? ` "${decodeEntities(c.attrs.title)}"` : ''})`
        } else {
          out += inner
        }
        break
      }
      case 'strong':
      case 'b':
        out += `**${trimLines(renderInline(c.children))}**`
        break
      case 'em':
      case 'i':
        out += `*${trimLines(renderInline(c.children))}*`
        break
      case 'code':
        out += '`' + nodeText(c.children).replace(/\s+/g, ' ') + '`'
        break
      case 'del':
      case 's':
        out += `~~${trimLines(renderInline(c.children))}~~`
        break
      default:
        out += renderInline(c.children)
    }
  }
  return out
}

function tableToMd(table: HtmlNode): string {
  const rows: string[][] = []
  const walkRows = (n: HtmlNode) => {
    for (const ch of n.children) {
      if (typeof ch === 'string') continue
      if (ch.tag === 'tr') {
        const cells: string[] = []
        for (const cell of ch.children) {
          if (typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th')) {
            cells.push(trimLines(renderInline(cell.children)).replace(/\s*\n\s*/g, ' ').trim())
          }
        }
        if (cells.length) rows.push(cells)
      } else if (['thead', 'tbody', 'tfoot'].includes(ch.tag)) {
        walkRows(ch)
      }
    }
  }
  walkRows(table)
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').replace(/\|/g, '\\|')))
  const header = norm[0]
  const body = norm.slice(1)
  let out = `| ${header.join(' | ')} |\n| ${Array(width).fill('---').join(' | ')} |\n`
  for (const r of body) out += `| ${r.join(' | ')} |\n`
  return out
}

function renderBlocks(nodes: (HtmlNode | string)[], ctx: { listDepth: number; quote: boolean }): string {
  let out = ''
  for (const c of nodes) {
    if (typeof c === 'string') {
      const t = c.trim()
      if (t) out += decodeEntities(t).replace(/\s+/g, ' ') + '\n\n'
      continue
    }
    if (SKIP_TAGS.has(c.tag)) continue
    if (/^h[1-6]$/.test(c.tag)) {
      const level = Number(c.tag[1])
      out += '#'.repeat(level) + ' ' + trimLines(renderInline(c.children)) + '\n\n'
    } else if (c.tag === 'p') {
      const t = trimLines(renderInline(c.children))
      if (t) out += (ctx.quote ? blockquote(t, ctx) : t) + '\n\n'
    } else if (c.tag === 'blockquote') {
      const inner = trimLines(renderBlocks(c.children, { ...ctx, quote: true }))
      out += blockquote(inner, ctx) + '\n\n'
    } else if (c.tag === 'pre') {
      const code = nodeText(c.children).replace(/\n$/, '')
      out += '```\n' + decodeEntities(code) + '\n```\n\n'
    } else if (c.tag === 'ul' || c.tag === 'ol') {
      out += renderList(c, ctx, c.tag === 'ol') + '\n'
    } else if (c.tag === 'li') {
      out += renderListItem(c, ctx, false, 0)
    } else if (c.tag === 'hr') {
      out += '---\n\n'
    } else if (c.tag === 'table') {
      out += tableToMd(c) + '\n'
    } else if (c.tag === 'img') {
      const inline = renderInline([c]).trim()
      if (inline) out += inline + '\n\n'
    } else if (BLOCK_TAGS.has(c.tag)) {
      out += renderBlocks(c.children, ctx)
    } else {
      const t = renderInline(c.children)
      if (t.trim()) out += t
    }
  }
  return out
}

function blockquote(text: string, ctx: { listDepth: number }): string {
  const indent = '  '.repeat(ctx.listDepth)
  return text
    .split('\n')
    .map((l) => indent + '> ' + l)
    .join('\n')
}

function renderList(list: HtmlNode, ctx: { listDepth: number; quote: boolean }, ordered: boolean): string {
  let out = ''
  let idx = 1
  for (const c of list.children) {
    if (typeof c === 'string') continue
    if (c.tag === 'li') {
      out += renderListItem(c, ctx, ordered, idx++)
    }
  }
  return out
}

function renderListItem(
  li: HtmlNode,
  ctx: { listDepth: number; quote: boolean },
  ordered: boolean,
  idx: number,
): string {
  const indent = '  '.repeat(ctx.listDepth)
  // 分离直接文本与嵌套列表
  let head = ''
  let nested = ''
  for (const ch of li.children) {
    if (typeof ch === 'string') {
      head += decodeEntities(ch)
    } else if (ch.tag === 'ul' || ch.tag === 'ol') {
      nested += renderList(ch, { ...ctx, listDepth: ctx.listDepth + 1 }, ch.tag === 'ol')
    } else if (ch.tag === 'p') {
      head += renderInline(ch.children)
    } else {
      head += renderInline(ch.children)
    }
  }
  const marker = ordered ? `${idx}. ` : '- '
  let out = indent + marker + trimLines(head).replace(/\s+/g, ' ') + '\n'
  if (nested) out += nested
  return out
}

/** HTML 文档 → Markdown 文本 */
export function htmlToMarkdown(html: string): string {
  const nodes = parseHtml(stripIrrelevant(html))
  let body = nodes
  // 仅取 <body> 内容；没有 body 则使用整棵树
  const findTag = (ns: (HtmlNode | string)[], tag: string): HtmlNode | null => {
    for (const n of ns) {
      if (typeof n !== 'string') {
        if (n.tag === tag) return n
        const hit = findTag(n.children, tag)
        if (hit) return hit
      }
    }
    return null
  }
  const bodyNode = findTag(nodes, 'body')
  if (bodyNode) body = bodyNode.children
  const md = renderBlocks(body, { listDepth: 0, quote: false })
  return normalizeMd(md)
}

/** 丢弃 head/script/style 等片段，减少解析噪声 */
function stripIrrelevant(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
}

/** Markdown 空行折叠与行尾清理 */
export function normalizeMd(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'
}
