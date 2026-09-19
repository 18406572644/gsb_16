/**
 * 行级结构差异（用于导入预览）。
 *
 * - 以「行」为基本单位做 LCS 对齐，输出 equal/insert/delete 序列；
 * - 小/中等规模走经典动态规划；行积超预算时切换 Hunt–Szymanski（按哈希匹配表，
 *   稀疏匹配下近似线性），匹配对仍然过多（大量重复行）时退化为「公共前后缀 + 整体替换」；
 * - 输出时把远离变更的 equal 区域折叠为 skip 块（只保留变更点前后各 CONTEXT 行），
 *   避免超长文档的差异结果撑爆传输与渲染。
 *
 * 本文件前后端通用，禁止引入环境 API。
 */
import { LCS_CELL_BUDGET, type DocDiffStats, type DiffLine } from './transfer'

/** 每个变更块保留的上下文行数 */
export const DIFF_CONTEXT = 3

interface Pair {
  i: number
  j: number
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  // 末尾换行符会产生一个空串元素，不属于真实行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 经典 LCS 动态规划（仅在行积预算内使用），返回匹配对（升序） */
function lcsDp(a: string[], b: string[]): Pair[] {
  const n = a.length
  const m = b.length
  const cols = m + 1
  // dp：Int32 长度矩阵（预算上限 12e6 * 4B = 48MB，可接受；只在解析请求期间短暂存在）
  const dp = new Int32Array((n + 1) * cols)
  const idx = (i: number, j: number) => i * cols + j
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    const rowBase = i * cols
    const prevBase = (i - 1) * cols
    for (let j = 1; j <= m; j++) {
      dp[rowBase + j] =
        ai === b[j - 1]
          ? dp[prevBase + j - 1] + 1
          : Math.max(dp[prevBase + j], dp[rowBase + j - 1])
    }
  }
  const pairs: Pair[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push({ i: i - 1, j: j - 1 })
      i--
      j--
    } else if (dp[idx(i - 1, j)] >= dp[idx(i, j - 1)]) {
      i--
    } else {
      j--
    }
  }
  pairs.reverse()
  return pairs
}

/**
 * Hunt–Szymanski：按 b 行内容建立 a 中匹配位置表，逐条 b 行更新 LCS 阈值链。
 * 适合匹配稀疏的大文档；返回匹配对（升序）。
 */
function lcsHuntSzymanski(a: string[], b: string[]): Pair[] {
  const matchOf = new Map<string, number[]>()
  for (let i = 0; i < a.length; i++) {
    const key = a[i]
    let list = matchOf.get(key)
    if (!list) {
      list = []
      matchOf.set(key, list)
    }
    list.push(i)
  }

  // thresh[k]：长度为 k 的公共子序列结尾在 a 中的最小行号（k 从 1 起）
  const thresh: number[] = []
  const threshNode: number[] = []
  const nodeI: number[] = []
  const nodeJ: number[] = []
  const nodeLink: number[] = []
  // 候选匹配对总量预算：a、b 大量重复行时 R 更新次数为两者长度之积，需提前放弃降级
  let pairBudget = LCS_CELL_BUDGET

  for (let j = 0; j < b.length; j++) {
    const list = matchOf.get(b[j])
    if (!list) continue
    for (let k = list.length - 1; k >= 0; k--) {
      if (--pairBudget < 0) return []
      const i = list[k]
      // 二分：i 应成为的 LCS 长度位置
      let lo = 0
      let hi = thresh.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (thresh[mid] < i) lo = mid + 1
        else hi = mid
      }
      const link = lo > 0 ? threshNode[lo - 1] : -1
      const nodeIdx = nodeI.length
      nodeI.push(i)
      nodeJ.push(j)
      nodeLink.push(link)
      if (lo === thresh.length) {
        thresh.push(i)
        threshNode.push(nodeIdx)
      } else {
        thresh[lo] = i
        threshNode[lo] = nodeIdx
      }
    }
  }

  const pairs: Pair[] = []
  let node = threshNode.length ? threshNode[threshNode.length - 1] : -1
  while (node >= 0) {
    pairs.push({ i: nodeI[node], j: nodeJ[node] })
    node = nodeLink[node]
  }
  pairs.reverse()
  return pairs
}

/** 公共前后缀对齐（最终降级手段，保证任何规模都能在线性时间返回） */
function lcsPrefixSuffix(a: string[], b: string[]): Pair[] {
  const pairs: Pair[] = []
  const maxPre = Math.min(a.length, b.length)
  let pre = 0
  while (pre < maxPre && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < maxPre - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++
  }
  for (let k = 0; k < pre; k++) pairs.push({ i: k, j: k })
  for (let k = suf - 1; k >= 0; k--) pairs.push({ i: a.length - 1 - k, j: b.length - 1 - k })
  return pairs
}

/** 由匹配对展开为完整的行操作序列（含 equal 行） */
function expand(a: string[], b: string[], pairs: Pair[]): DiffLine[] {
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  for (const p of pairs) {
    while (i < p.i) out.push({ op: 'delete', oldNo: i, newNo: -1, text: a[i++] })
    while (j < p.j) out.push({ op: 'insert', oldNo: -1, newNo: j, text: b[j++] })
    out.push({ op: 'equal', oldNo: i, newNo: j, text: a[i] })
    i++
    j++
  }
  while (i < a.length) out.push({ op: 'delete', oldNo: i, newNo: -1, text: a[i++] })
  while (j < b.length) out.push({ op: 'insert', oldNo: -1, newNo: j, text: b[j++] })
  return out
}

/**
 * 折叠远离变更点的 equal 行为 skip 标记（每侧保留 CONTEXT 行，相邻块间隙小则合并）。
 * skip 行：text 为空，oldNo/newNo 指向被跳过的行数（放 count 字段，由调用方按需读取），
 * 这里复用 DiffLine，附加 skipped 字段（弱类型扩展，渲染端可选识别）。
 */
export function foldContext(lines: DiffLine[]): DiffLine[] {
  const changeIdx: number[] = []
  lines.forEach((l, idx) => {
    if (l.op !== 'equal') changeIdx.push(idx)
  })
  if (changeIdx.length === 0) {
    // 无变化：超长相同文档只展示前 CONTEXT*2 行
    if (lines.length <= DIFF_CONTEXT * 2) return lines
    return [
      ...lines.slice(0, DIFF_CONTEXT),
      { op: 'skip', oldNo: -1, newNo: -1, text: '', skipped: lines.length - DIFF_CONTEXT * 2 } as DiffLine,
      ...lines.slice(lines.length - DIFF_CONTEXT),
    ]
  }

  const keep = new Uint8Array(lines.length)
  for (const ci of changeIdx) {
    for (let k = Math.max(0, ci - DIFF_CONTEXT); k <= Math.min(lines.length - 1, ci + DIFF_CONTEXT); k++) {
      keep[k] = 1
    }
  }

  const out: DiffLine[] = []
  let i = 0
  while (i < lines.length) {
    if (keep[i]) {
      out.push(lines[i])
      i++
      continue
    }
    let end = i
    while (end < lines.length && !keep[end]) end++
    const skipped = end - i
    out.push({ op: 'skip', oldNo: -1, newNo: -1, text: '', skipped } as DiffLine)
    i = end
  }
  return out
}

export interface LineDiffResult {
  lines: DiffLine[]
  stats: DocDiffStats
  /** 对齐算法：dp（精确）/ huntszymanski（哈希精确）/ prefix（降级前后缀） */
  algorithm: 'dp' | 'huntszymanski' | 'prefix'
}

/** 计算 oldText → newText 的行级结构差异 */
export function lineDiff(oldText: string, newTextText: string): LineDiffResult {
  const a = splitLines(oldText)
  const b = splitLines(newTextText)

  let pairs: Pair[]
  let algorithm: LineDiffResult['algorithm']
  if (a.length * Math.max(b.length, 1) <= LCS_CELL_BUDGET) {
    pairs = lcsDp(a, b)
    algorithm = 'dp'
  } else {
    pairs = lcsHuntSzymanski(a, b)
    algorithm = 'huntszymanski'
    if (pairs.length === 0 && a.length > 0 && b.length > 0) {
      pairs = lcsPrefixSuffix(a, b)
      algorithm = 'prefix'
    }
  }

  const full = expand(a, b, pairs)
  let inserted = 0
  let deleted = 0
  let equal = 0
  for (const l of full) {
    if (l.op === 'insert') inserted++
    else if (l.op === 'delete') deleted++
    else equal++
  }

  return {
    lines: foldContext(full),
    stats: {
      inserted,
      deleted,
      equal,
      totalLines: Math.max(a.length, b.length),
      oldChars: oldText.length,
      newChars: newTextText.length,
    },
    algorithm,
  }
}
