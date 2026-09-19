/**
 * Markdown → HTML 导出（零第三方依赖）。
 *
 * 面向导出场景的取舍：
 * - 输出完整 HTML5 文档，内置中文字体栈与打印样式，长文档分段流式处理无压力；
 * - 原文按字符转义，特殊字符 / emoji 原样保留；
 * - 支持 ATX 标题、段落、有序/无序列表（含缩进嵌套）、引用、围栏代码、
 *   分割线、GFM 表格、行内代码/加粗/斜体/删除线/链接/图片/自动链接；
 * - 不做任何智能引号或空白折叠，避免破坏中文排版与代码。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

const INLINE_RE =
  /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)|\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)|(\*\*|__)(?=\S)([\s\S]*?\S)\9|(\*|_)(?=\S)([\s\S]*?\S)\11|(~~)(?=\S)([\s\S]*?\S)~~|<((?:https?:|mailto:)[^>\s]+)>/

function renderInline(text: string): string {
  let out = ''
  let last = 0
  const re = new RegExp(INLINE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out += escapeHtml(text.slice(last, m.index))
    const [, codeFence, codeBody, imgAlt, imgSrc, imgTitle, linkText, linkHref, linkTitle,
      bFence, bBody, iFence, iBody, sFence, sBody, autoUrl] = m
    if (codeFence !== undefined) {
      out += `<code>${escapeHtml(codeBody)}</code>`
    } else if (imgSrc !== undefined) {
      const title = imgTitle ? ` title="${escapeAttr(imgTitle)}"` : ''
      out += `<img src="${escapeAttr(imgSrc)}" alt="${escapeAttr(imgAlt)}"${title} loading="lazy" />`
    } else if (linkHref !== undefined) {
      const title = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : ''
      out += `<a href="${escapeAttr(linkHref)}"${title} target="_blank" rel="noopener noreferrer">${renderInline(linkText)}</a>`
    } else if (bFence !== undefined) {
      out += `<strong>${renderInline(bBody)}</strong>`
    } else if (iFence !== undefined) {
      out += `<em>${renderInline(iBody)}</em>`
    } else if (sFence !== undefined) {
      out += `<del>${renderInline(sBody)}</del>`
    } else if (autoUrl !== undefined) {
      out += `<a href="${escapeAttr(autoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(autoUrl)}</a>`
    }
    last = re.lastIndex
  }
  out += escapeHtml(text.slice(last))
  // 裸 URL 自动链接（未被上述语法包裹的 http(s) 链接；引号/等号之后的 URL 属于 HTML 属性，跳过）
  out = out.replace(/(^|[\s（(>】])(https?:\/\/[^\s<）)"']+)/g, (_m, pre: string, url: string) => {
    return `${pre}<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
  })
  return out
}

interface RawListItem {
  indent: number
  ordered: boolean
  text: string
}

/** 按缩进构建嵌套列表：缩进加深开启子列表，标记类型变化（ul⇄ol）也分组 */
function renderNestedList(items: RawListItem[], from = 0, baseIndent?: number, depth = 0): { html: string; next: number } {
  if (from >= items.length) return { html: '', next: from }
  const indent = baseIndent ?? items[from]!.indent
  // 同层相邻条目：标记类型切换时另起一个 <ul>/<ol>
  let html = ''
  let k = from
  while (k < items.length) {
    const it = items[k]!
    if (it.indent < indent) break
    if (it.indent > indent) {
      // 缩进跳跃（缺少同层父项）：直接递归消费更深的条目
      const sub = renderNestedList(items, k, undefined, depth + 1)
      html += sub.html
      k = sub.next
      continue
    }
    const ordered = it.ordered
    const tag = ordered ? 'ol' : 'ul'
    html += `<${tag}>`
    while (k < items.length) {
      const cur = items[k]!
      if (cur.indent < indent) break
      if (cur.indent > indent) break // 子列表由递归处理
      if (cur.ordered !== ordered) break
      html += `<li>${renderInline(cur.text.trim())}`
      k++
      if (k < items.length && items[k]!.indent > indent) {
        const sub = renderNestedList(items, k, undefined, depth + 1)
        html += sub.html
        k = sub.next
      }
      html += '</li>'
    }
    html += `</${tag}>`
  }
  return { html, next: k }
}

function splitTable(s: string): string[] | null {
  if (s[0] !== '|') return null
  const cells: string[] = []
  let cur = ''
  let i = 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[i + 1]
      i += 2
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  return cells
}

function isDivider(s: string): boolean {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(s)
}

/** Markdown 正文 → HTML 片段（不含 <html> 外壳） */
export function markdownToHtmlBody(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 围栏代码块
    const fence = /^\s{0,3}(```+|~~~+)(.*)$/.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const lang = (fence[2] || '').trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`).test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏
      const langAttr = lang && /^[\w-]+$/.test(lang) ? ` class="language-${escapeAttr(lang)}"` : ''
      out.push(`<pre><code${langAttr}>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    // 标题
    const atx = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/.exec(line)
    if (atx && line.includes('#')) {
      const level = atx[1].length
      const title = (atx[2] || '').trim()
      if (title || /^\s{0,3}#{1,6}\s*$/.test(line) === false) {
        out.push(`<h${level}>${renderInline(title)}</h${level}>`)
        i++
        continue
      }
    }

    // 分割线
    if (isDivider(line)) {
      out.push('<hr />')
      i++
      continue
    }

    // 表格（表头 | 分隔行 | 数据行）
    const headCells = splitTable(line.trim())
    const nextLine = lines[i + 1] || ''
    if (headCells && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(nextLine)) {
      const sepCells = nextLine.split('|').slice(1).map((c) => c.trim())
      const aligns = sepCells.map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
      })
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitTable(lines[i].trim())
        if (cells) rows.push(cells)
        i++
      }
      out.push('<table>')
      out.push('<thead><tr>' + headCells.map((c, k) =>
        `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${renderInline(c)}</th>`).join('') + '</tr></thead>')
      out.push('<tbody>')
      for (const r of rows) {
        out.push('<tr>' + headCells.map((_, k) =>
          `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${renderInline(r[k] ?? '')}</td>`).join('') + '</tr>')
      }
      out.push('</tbody></table>')
      continue
    }

    // 引用块（连续 > 行，支持嵌套按 > 个数）
    if (/^\s{0,3}>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (buf.length && lines[i].trim()))) {
        if (/^\s{0,3}>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
          i++
        } else break
        // 引用内允许空行（至多一行为段落间隔）
        while (i < lines.length && !lines[i].trim() && /^\s{0,3}>/.test(lines[i + 1] || '')) {
          buf.push('')
          i++
        }
      }
      out.push(`<blockquote>${markdownToHtmlBody(buf.join('\n')).trim()}</blockquote>`)
      continue
    }

    // 列表（支持缩进嵌套；连续同层条目分组为 ul/ol，深层条目渲染为子列表）
    const listMatch = /^(\s{0,3})([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      const raw: RawListItem[] = []
      const itemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
      while (i < lines.length) {
        const lm = itemRe.exec(lines[i])
        if (lm) {
          raw.push({
            indent: Math.min(lm[1].replace(/\t/g, '  ').length, 12),
            ordered: /^\d+[.)]$/.test(lm[2]),
            text: lm[3],
          })
          i++
          continue
        }
        // 缩进的非标记续行并入上一项
        if (raw.length && /^\s{2,}\S/.test(lines[i])) {
          raw[raw.length - 1].text += ' ' + lines[i].trim()
          i++
          continue
        }
        // 容忍条目之间的单个空行
        if (!lines[i].trim() && itemRe.test(lines[i + 1] || '')) {
          i++
          continue
        }
        break
      }
      out.push(renderNestedList(raw).html)
      continue
    }

    // 普通段落：连续非空、非块起始的行
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s{0,3}(#{1,6})\s/.test(lines[i]) &&
      !/^\s{0,3}>/.test(lines[i]) &&
      !/^\s{0,3}(```+|~~~+)/.test(lines[i]) &&
      !/^(\s{0,3})([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('|') &&
      !isDivider(lines[i])
    ) {
      para.push(lines[i].trim())
      i++
    }
    if (para.length) out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br />')}</p>`)
  }

  return out.join('\n')
}

/** 完整 HTML 文档外壳：中文友好字体栈、长文打印样式 */
export function wrapHtmlDocument(body: string, opts: { title: string; extraHead?: string; extraCss?: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
${opts.extraHead || ''}
<style>
:root { --fg:#1f2329; --muted:#8a8f99; --border:#e5e6eb; --hl:#fff3c4; --hl-resolved:#e8f5e9; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 48px 120px;
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC",
    "WenQuanYi Micro Hei", sans-serif;
  font-size: 15px; line-height: 1.75;
  word-wrap: break-word; overflow-wrap: anywhere;
}
h1,h2,h3,h4,h5,h6 { line-height: 1.35; margin: 1.4em 0 .6em; }
h1 { font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: .3em; }
h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
p { margin: .55em 0; }
a { color: #2b6cb0; text-decoration: none; } a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; border-radius: 4px; }
pre { background:#f6f7f9; border:1px solid var(--border); border-radius:6px;
  padding:12px 14px; overflow:auto; }
code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", "Source Han Mono SC", monospace;
  font-size: .92em; background:#f6f7f9; padding: .1em .35em; border-radius: 3px; }
pre code { background: none; padding: 0; }
blockquote { margin: .6em 0; padding: .2em 1em; color:#555; border-left: 4px solid var(--border); }
table { border-collapse: collapse; width: 100%; margin: .8em 0; display: block; overflow-x: auto; }
th,td { border: 1px solid var(--border); padding: 6px 12px; }
th { background: #fafafa; }
hr { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }
${opts.extraCss || ''}
@media print { body { padding: 0; } .ann-comment, .ann-sidebar { display: none; } }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

/** 便捷方法：Markdown 直接导出为完整 HTML 文档 */
export function markdownToHtmlDocument(md: string, title: string): string {
  return wrapHtmlDocument(markdownToHtmlBody(md), { title })
}
