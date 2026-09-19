/**
 * 文档导入外观层：按格式分派解析器，统一输出 ParsedDocument。
 * 解析结果只生成「待确认版本」，绝不触碰协作正文。
 */
import type { ConvertWarning, DocFormat } from '../../../shared/transfer'
import { MAX_TEXT_CHARS } from '../../../shared/transfer'
import { decodeBytes, normalizeText } from './encoding'
import { htmlToText } from './htmlParser'
import { docxToText } from './docxParser'

export interface ParsedDocument {
  text: string
  encoding: string
  lineEnding: 'LF' | 'CRLF' | 'CR'
  warnings: ConvertWarning[]
  stats: {
    chars: number
    lines: number
    links: number
    images: number
    comments: number
  }
}

/** 统计 Markdown 语法中的链接与图片（txt 也用同一统计，纯文本里出现的 Markdown 语法会被如实计数） */
function countMarkdownRefs(text: string): { links: number; images: number } {
  const images = (text.match(/!\[[^\]]*\]\([^)\s]+/g) || []).length
  // 排除图片语法的链接数
  const links = (text.match(/(?<!!)\[[^\]]+\]\((?:https?|mailto|ftp):[^)\s]+/g) || []).length
  // 裸 URL
  const bare = (text.match(/(?<![(\w])https?:\/\/[^\s)）】]+/g) || []).length
  return { links: links + bare, images }
}

export function parseDocument(buf: Buffer, format: DocFormat, maxChars = MAX_TEXT_CHARS): ParsedDocument {
  const warnings: ConvertWarning[] = []

  if (format === 'docx') {
    const parsed = docxToText(buf)
    const norm = normalizeText(parsed.text, maxChars)
    warnings.push(...parsed.warnings, ...norm.warnings)
    const lines = norm.text === '' ? 0 : norm.text.split('\n').length - (norm.text.endsWith('\n') ? 1 : 0)
    return {
      text: norm.text,
      encoding: 'utf-8 (zip/ooxml)',
      lineEnding: norm.lineEnding,
      warnings,
      stats: {
        chars: norm.text.length,
        lines,
        links: parsed.links,
        images: parsed.images,
        comments: parsed.comments,
      },
    }
  }

  const decoded = decodeBytes(buf)
  warnings.push(...decoded.warnings)

  let body = decoded.text
  let links = 0
  let images = 0

  if (format === 'html') {
    const r = htmlToText(body)
    body = r.text
    links = r.links
    images = r.images
    warnings.push(...r.warnings)
  }

  const norm = normalizeText(body, maxChars)
  warnings.push(...norm.warnings)

  if (format === 'md' || format === 'txt') {
    const refs = countMarkdownRefs(norm.text)
    links += refs.links
    images += refs.images
  }

  const lines = norm.text === '' ? 0 : norm.text.split('\n').length - (norm.text.endsWith('\n') ? 1 : 0)
  return {
    text: norm.text,
    encoding: decoded.encoding,
    lineEnding: norm.lineEnding,
    warnings,
    stats: { chars: norm.text.length, lines, links, images, comments: 0 },
  }
}
