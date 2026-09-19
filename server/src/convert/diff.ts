/**
 * 行级结构差异：现稿（old）→ 导入稿（neu）。
 *
 * 采用「唯一行锚点」分段 + 小区间动态规划的策略：
 * - 先以两侧均唯一出现的行作为相等锚点线性切分；
 * - 锚点之间的差异区间若不大（≤ DP_LIMIT），用经典 LCS DP 求精细对齐；
 * - 超大区间直接整体判为 removed/added，保证超长文档下整体近似线性复杂度。
 */
import type { DiffBlock } from '../../../shared/convert'

const DP_LIMIT = 400

interface EqualAnchor {
  oi: number
  ni: number
}

/** 找出两侧均唯一出现的行作为锚点（按出现顺序） */
function uniqueAnchors(oldLines: string[], newLines: string[]): EqualAnchor[] {
  const oldPos = new Map<string, number>()
  const oldDup = new Set<string>()
  oldLines.forEach((l, i) => {
    if (oldPos.has(l)) oldDup.add(l)
    else oldPos.set(l, i)
  })
  const newSeen = new Set<string>()
  const anchors: EqualAnchor[] = []
  let lastO = -1
  let lastN = -1
  newLines.forEach((l, ni) => {
    if (newSeen.has(l) || oldDup.has(l)) {
      newSeen.add(l)
      return
    }
    newSeen.add(l)
    const oi = oldPos.get(l)
    if (oi !== undefined && oi > lastO && ni > lastN) {
      // 跳过空行锚点（过于常见，容易错配）
      if (l.trim() !== '') {
        anchors.push({ oi, ni })
        lastO = oi
        lastN = ni
      }
    }
  })
  return anchors
}

/** 小区间内经典 LCS DP，输出对齐后的块（不含区间外内容） */
function lcsRegion(a: string[], b: string[], lineA: number, lineB: number): DiffBlock[] {
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const blocks: DiffBlock[] = []
  let i = 0
  let j = 0
  const push = (type: DiffBlock['type'], text: string, oi: number, ni: number) => {
    blocks.push({
      type,
      text,
      oldLine: type === 'added' ? null : lineA + oi,
      newLine: type === 'removed' ? null : lineB + ni,
    })
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i], i, j)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('removed', a[i], i, -1)
      i++
    } else {
      push('added', b[j], -1, j)
      j++
    }
  }
  while (i < n) {
    push('removed', a[i], i, -1)
    i++
  }
  while (j < m) {
    push('added', b[j], -1, j)
    j++
  }
  return blocks
}

function wholeRegion(a: string[], b: string[], lineA: number, lineB: number): DiffBlock[] {
  const blocks: DiffBlock[] = []
  a.forEach((text, k) => blocks.push({ type: 'removed', text, oldLine: lineA + k, newLine: null }))
  b.forEach((text, k) => blocks.push({ type: 'added', text, oldLine: null, newLine: lineB + k }))
  return blocks
}

/**
 * 计算结构差异。
 * @param oldText 现稿（协作正文）
 * @param newText 导入待确认稿
 */
export function diffLines(oldText: string, newText: string): DiffBlock[] {
  const a = oldText.replace(/\r\n?/g, '\n').split('\n')
  const b = newText.replace(/\r\n?/g, '\n').split('\n')
  const blocks: DiffBlock[] = []
  const anchors = uniqueAnchors(a, b)

  let lineA = 0
  let lineB = 0
  let ai = 0
  let bi = 0
  const emitRegion = (endA: number, endB: number) => {
    const ra = a.slice(ai, endA)
    const rb = b.slice(bi, endB)
    if (ra.length <= DP_LIMIT && rb.length <= DP_LIMIT) {
      blocks.push(...lcsRegion(ra, rb, lineA, lineB))
    } else {
      blocks.push(...wholeRegion(ra, rb, lineA, lineB))
    }
    lineA += ra.length
    lineB += rb.length
    ai = endA
    bi = endB
  }

  for (const anc of anchors) {
    if (anc.oi > ai || anc.ni > bi) emitRegion(anc.oi, anc.ni)
    blocks.push({ type: 'equal', text: a[anc.oi], oldLine: lineA, newLine: lineB })
    ai = anc.oi + 1
    bi = anc.ni + 1
    lineA++
    lineB++
  }
  if (ai < a.length || bi < b.length) emitRegion(a.length, b.length)
  return blocks
}

export function diffSummary(diff: DiffBlock[]): { added: number; removed: number; equal: number } {
  const s = { added: 0, removed: 0, equal: 0 }
  for (const d of diff) s[d.type]++
  return s
}
