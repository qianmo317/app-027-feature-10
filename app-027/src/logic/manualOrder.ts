import type { OrderOverride } from './types'
import type { Pt } from './types'
import { dist } from './geometry'
import type { JobStep } from './job'

/** 段唯一 key：形状 + 轮廓 + 连刀段下标 */
export function stepKey(st: { shapeId: string; contourId: string; runIndex: number }): string {
  return `${st.shapeId}:${st.contourId}:${st.runIndex}`
}

export type ManualStats = {
  /** 当前（手工）顺序跳刀总长 mm */
  travelMm: number
  /** 自动顺序跳刀总长 mm */
  autoTravelMm: number
  /** 相对自动顺序多走的跳刀 mm（≥0；手工顺序更短时为 0） */
  extraTravelMm: number
  /** 相对朴素顺序的缩短比例（%） */
  improvementPct: number
  naiveTravelMm: number
  /** 位置发生变化的段数 */
  movedCount: number
  /** 固定段数 */
  pinnedCount: number
}

export type ManualOrderResult = {
  /** 生效的段顺序（key 排列） */
  order: string[]
  /** 固定段 key */
  pinned: string[]
  /** 段查表（按 key），已带新顺序号与重算的跳刀 */
  byKey: Map<string, JobStep>
  /** 自动顺序中各段的位置（用于对比着色） */
  autoRank: Map<string, number>
  stats: ManualStats
}

/** 按 key 顺序应用手工排列：重算每段跳刀与顺序号，返回按 key 索引的段表 */
function arrange(order: string[], autoByKey: Map<string, JobStep>): Map<string, JobStep> {
  const out = new Map<string, JobStep>()
  let cursor: Pt | null = null
  let seq = 0
  for (const key of order) {
    const st = autoByKey.get(key)
    if (!st) continue
    seq += 1
    out.set(key, { ...st, seq, travelFromPrevMm: cursor === null ? 0 : dist(cursor, st.startPt) })
    cursor = st.endPt
  }
  return out
}

function sumTravel(steps: JobStep[]): number {
  let s = 0
  for (const st of steps) s += st.travelFromPrevMm
  return s
}

/** 手工顺序是否仍然匹配当前几何（段集合一致）；不匹配时自动顺序不可用，需一键退回 */
export function overrideMatches(autoSteps: JobStep[], override: OrderOverride | undefined | null): override is OrderOverride {
  if (!override) return false
  const autoKeys = autoSteps.map(stepKey)
  if (override.order.length !== autoKeys.length) return false
  const set = new Set(override.order)
  if (set.size !== override.order.length) return false
  return autoKeys.every((k) => set.has(k))
}

/** 按段排列应用手工顺序（不重新优化），返回带新跳刀与对比信息的结果；覆盖失效时返回 null */
export function resolveManual(autoSteps: JobStep[], override: OrderOverride | undefined | null): ManualOrderResult | null {
  if (!overrideMatches(autoSteps, override)) return null
  const autoByKey = new Map<string, JobStep>()
  for (const st of autoSteps) autoByKey.set(stepKey(st), st)

  const validPinned = new Set(override.pinned.filter((k) => autoByKey.has(k)))
  const byKey = arrange(override.order, autoByKey)
  const travelMm = sumTravel([...byKey.values()])
  const autoTravelMm = sumTravel(autoSteps)

  const autoRank = new Map<string, number>()
  autoSteps.forEach((st, i) => autoRank.set(stepKey(st), i))
  let movedCount = 0
  override.order.forEach((key, i) => {
    if (autoRank.get(key) !== i) movedCount += 1
  })

  return {
    order: override.order.slice(),
    pinned: override.order.filter((k) => validPinned.has(k)),
    byKey,
    autoRank,
    stats: {
      travelMm,
      autoTravelMm,
      extraTravelMm: Math.max(0, travelMm - autoTravelMm),
      improvementPct: 0,
      naiveTravelMm: 0,
      movedCount,
      pinnedCount: validPinned.size,
    },
  }
}

type Ep = { start: Pt; end: Pt; layer: number }

/**
 * 带固定段约束的重排（同图层内进行，固定段保持绝对位置）：
 * 先按固定段把序列切成槽，每个槽用「最近邻 + 2-opt（不跨越固定段）」求解。
 */
export function solveOrder(
  keys: string[],
  ep: Map<string, Ep>,
  pinned: Set<string>,
  cursorStart: Pt,
): string[] {
  if (keys.length < 2) return keys.slice()

  // 固定段按当前绝对位置落在序列中
  const pinIdx: number[] = []
  keys.forEach((k, i) => {
    if (pinned.has(k)) pinIdx.push(i)
  })

  const slots: Array<{ free: string[]; from: Pt; to: Pt | null }> = []
  let prevEnd = cursorStart
  let lo = 0
  for (const pi of pinIdx) {
    slots.push({ free: keys.slice(lo, pi), from: prevEnd, to: ep.get(keys[pi])!.start })
    prevEnd = ep.get(keys[pi])!.end
    lo = pi + 1
  }
  slots.push({ free: keys.slice(lo), from: prevEnd, to: null })

  const startOf = (k: string): Pt => ep.get(k)?.start ?? cursorStart
  const endOf = (k: string): Pt => ep.get(k)?.end ?? cursorStart

  const nearest = (ids: string[], from: Pt): string[] => {
    const remaining = ids.slice()
    const out: string[] = []
    let cur = from
    while (remaining.length > 0) {
      let bi = 0
      let bd = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const d = dist(cur, startOf(remaining[i]))
        if (d < bd) {
          bd = d
          bi = i
        }
      }
      const id = remaining.splice(bi, 1)[0]
      out.push(id)
      cur = endOf(id)
    }
    return out
  }

  /** 2-opt：只反转子序列，绝不跨越固定段（槽内无固定段），且首尾端点固定 */
  const twoOpt = (seq: string[], from: Pt, to: Pt | null): string[] => {
    const s = seq.slice()
    const n = s.length
    if (n < 3) return s
    let improved = true
    let guard = 0
    while (improved && guard < 30) {
      improved = false
      guard += 1
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const prev = i > 0 ? endOf(s[i - 1]) : from
          const next = j < n - 1 ? startOf(s[j + 1]) : to
          const before = dist(prev, startOf(s[i])) + (next ? dist(endOf(s[j]), next) : 0)
          const after = dist(prev, startOf(s[j])) + (next ? dist(endOf(s[i]), next) : 0)
          if (after < before - 1e-9) {
            let a = i
            let b = j
            while (a < b) {
              const tmp = s[a]
              s[a] = s[b]
              s[b] = tmp
              a += 1
              b -= 1
            }
            improved = true
          }
        }
      }
    }
    return s
  }

  // 依次填充：槽 → 固定段 → 槽 …
  const filled: string[] = []
  let si = 0
  for (const pi of pinIdx) {
    const slot = slots[si]
    let seq = nearest(slot.free, slot.from)
    seq = twoOpt(seq, slot.from, slot.to)
    filled.push(...seq)
    filled.push(keys[pi])
    si += 1
  }
  const last = slots[slots.length - 1]
  filled.push(...twoOpt(nearest(last.free, last.from), last.from, null))
  return filled
}

/**
 * 绕开固定段重新优化当前手工顺序（同图层内）：固定段保持绝对位置，
 * 其余段在各自槽位内重新做最近邻 + 2-opt。
 */
export function reoptimizeManual(autoSteps: JobStep[], override: OrderOverride): ManualOrderResult | null {
  if (!overrideMatches(autoSteps, override)) return null
  const autoByKey = new Map<string, JobStep>()
  for (const st of autoSteps) autoByKey.set(stepKey(st), st)
  const pinned = new Set(override.pinned.filter((k) => autoByKey.has(k)))

  // 按图层分组；图层顺序沿用自动顺序
  const layers: number[] = []
  for (const st of autoSteps) {
    if (!layers.includes(st.shapeLayer)) layers.push(st.shapeLayer)
  }

  const ep = new Map<string, Ep>()
  for (const st of autoSteps) ep.set(stepKey(st), { start: st.startPt, end: st.endPt, layer: st.shapeLayer })

  // 手工顺序（含固定位置）；上一图层结束点作为下一图层起点（起点与 buildJob 一致为 (0,0)）
  const cur = override.order.slice()
  const ordered: string[] = []
  let cursor: Pt = { x: 0, y: 0 }
  for (const layer of layers) {
    const inLayer = cur.filter((k) => autoByKey.get(k)?.shapeLayer === layer)
    const layerPinned = new Set(inLayer.filter((k) => pinned.has(k)))
    const solved = solveOrder(inLayer, ep, layerPinned, cursor)
    ordered.push(...solved)
    const lastKey = solved[solved.length - 1]
    if (lastKey) cursor = ep.get(lastKey)!.end
  }

  return resolveManual(autoSteps, { order: ordered, pinned: override.pinned.filter((k) => autoByKey.has(k)) })
}

/** 初始手工顺序：从自动结果复制（用户随后可拖动 / 固定） */
export function initialOverride(autoSteps: JobStep[]): OrderOverride {
  return { order: autoSteps.map(stepKey), pinned: [] }
}

/**
 * 把 key 移动到绝对位置 to（0..order.length）。
 * 固定段保持绝对位置：可动范围被夹在前后最近固定段之间，跨不过固定段。
 * 返回新顺序；固定段自身被拖动时原样返回。
 */
export function moveKey(order: string[], pinned: Set<string>, key: string, to: number): string[] {
  const from = order.indexOf(key)
  if (from < 0 || pinned.has(key)) return order.slice()

  let lo = 0
  let hi = order.length
  for (let i = from - 1; i >= 0; i--) {
    if (pinned.has(order[i])) {
      lo = i + 1
      break
    }
  }
  for (let i = from + 1; i < order.length; i++) {
    if (pinned.has(order[i])) {
      hi = i
      break
    }
  }

  const next = order.slice()
  next.splice(from, 1)
  // 可动自由段在原数组中占据 [lo, hi)；删除一项后合法插入位置为 [lo, hi-1]
  let insertAt = to > from ? to - 1 : to
  insertAt = Math.min(Math.max(lo, insertAt), hi - 1)
  next.splice(insertAt, 0, key)
  return next
}
