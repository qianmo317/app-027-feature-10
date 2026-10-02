import type { OrderOverride, Pt } from './types'
import type { CutStep } from './order'
import { dist } from './geometry'

/** 一段刀路的稳定标识：轮廓 id + 该轮廓内的段序号 */
export function stepKey(st: Pick<CutStep, 'contourId' | 'runIndex'>): string {
  return `${st.contourId}#${st.runIndex}`
}

/** 固定段所在的槽位（在最终序列中的下标） */
export type PinSlot = { key: string; index: number; step: CutStep }

export type OverrideMeta = {
  /** 是否存在手工干预（拖动过或有固定段） */
  manual: boolean
  /** 固定段 */
  pins: PinSlot[]
  pinnedKeys: string[]
  /** 有效顺序里每段的 key（与 steps 对齐） */
  keys: string[]
  /** 完全自动顺序里每段的 key */
  autoKeys: string[]
  /** 有效顺序跳刀总长（mm，不含首次进刀） */
  travelMm: number
  /** 自动顺序跳刀总长（mm） */
  autoTravelMm: number
  /** 朴素顺序跳刀总长（mm，buildJob 原始结果） */
  naiveTravelMm: number
  /** 因手工干预（拖动/固定）相对自动结果多走的跳刀（mm） */
  extraTravelMm: number
  /** 手工顺序中有但当前几何已不存在、被丢弃的 key 数 */
  staleDropped: number
  /** 与自动顺序位置不同的段数 */
  movedCount: number
}

/** 按顺序重算每段的 seq 与到上一段末尾的跳刀距离 */
function renumber(steps: CutStep[], start: Pt): CutStep[] {
  let cursor = start
  let first = true
  return steps.map((st0, i) => {
    const st = { ...st0, seq: i + 1, travelFromPrevMm: first ? 0 : dist(cursor, st0.startPt) }
    cursor = st0.endPt
    first = false
    return st
  })
}

export function totalTravel(steps: CutStep[]): number {
  let s = 0
  for (const st of steps) s += st.travelFromPrevMm
  return s
}

/** 最近邻：自由段块内从入口点出发依次挑最近段，尽量贴近下一个固定段的起点 */
function nearestBlock<T extends CutStep>(free: T[], ep: Map<string, { start: Pt; end: Pt }>, entry: Pt, keyOf: (st: T) => string): T[] {
  const remaining = free.slice()
  const out: T[] = []
  let cur = entry
  while (remaining.length > 0) {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(cur, ep.get(keyOf(remaining[i]))!.start)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    const picked = remaining.splice(best, 1)[0]
    out.push(picked)
    cur = ep.get(keyOf(picked))!.end
  }
  return out
}

/** 开放路径 2-opt：只反转自由块内部子序列，不触碰固定段 */
function twoOptBlock<T extends CutStep>(seq: T[], ep: Map<string, { start: Pt; end: Pt }>, entry: Pt, keyOf: (st: T) => string): T[] {
  const s = seq.slice()
  const n = s.length
  const startOf = (i: number): Pt => ep.get(keyOf(s[i]))!.start
  const endOf = (i: number): Pt => ep.get(keyOf(s[i]))!.end
  let improved = true
  let guard = 0
  while (improved && guard < 40) {
    improved = false
    guard += 1
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const prev = i > 0 ? endOf(i - 1) : entry
        const next = j < n - 1 ? startOf(j + 1) : null
        const before = dist(prev, startOf(i)) + (next ? dist(endOf(j), next) : 0)
        const after = dist(prev, startOf(j)) + (next ? dist(endOf(i), next) : 0)
        if (after < before - 1e-9) {
          let lo = i
          let hi = j
          while (lo < hi) {
            const tmp = s[lo]
            s[lo] = s[hi]
            s[hi] = tmp
            lo += 1
            hi -= 1
          }
          improved = true
        }
      }
    }
  }
  return s
}

/**
 * 固定段不动（槽位 = 其在 slots 中的下标），把自由段分配到相邻固定段之间的
 * 各个块里，每块做最近邻 + 2-opt：入口为上一段（固定段或原点）末尾，
 * 出口尽量贴近下一个固定段起点。
 */
function arrangeByPins<T extends CutStep>(
  slots: (T | null)[],
  byKey: Map<string, T>,
  start: Pt,
  keyOf: (st: T) => string,
): T[] {
  const used = new Set<string>()
  const pins: { index: number; step: T }[] = []
  slots.forEach((st, i) => {
    if (st) {
      used.add(keyOf(st))
      pins.push({ index: i, step: st })
    }
  })
  const free = [...byKey.values()].filter((st) => !used.has(keyOf(st)))
  const ep = new Map<string, { start: Pt; end: Pt }>()
  for (const st of byKey.values()) ep.set(keyOf(st), { start: st.startPt, end: st.endPt })

  const result: T[] = new Array(slots.length).fill(null) as T[]
  for (const p of pins) result[p.index] = p.step

  const boundaries = [-1, ...pins.map((p) => p.index), slots.length]
  let cursor = 0
  for (let b = 0; b < boundaries.length - 1; b++) {
    const lo = boundaries[b] + 1
    const hi = boundaries[b + 1] - 1
    const size = Math.max(0, hi - lo + 1)
    if (size === 0) continue
    const entry: Pt = lo > 0 && result[lo - 1] ? result[lo - 1].endPt : start
    const blockAll = free.slice(cursor, cursor + size)
    cursor += size
    const block = twoOptBlock(nearestBlock(blockAll, ep, entry, keyOf), ep, entry, keyOf)
    block.forEach((st, k) => {
      result[lo + k] = st
    })
  }
  return result.filter(Boolean)
}

/**
 * 把手工覆盖应用到自动任务序列：
 * - 几何变化导致 key 对不上时，丢弃失效 key（staleDropped），新出现的段补到队尾；
 * - 无手工顺序（仅固定）时，固定段锚在 anchorKeys 中的位置（默认自动顺序），其余自由段就近重排；
 * - 有手工顺序时，完全按手工顺序，固定段只用于 UI 标识。
 * keyOf 允许调用方使用与覆盖数据一致的稳定 key（如共边去重后的片段 key）。
 * 返回的 steps 已重排并重算 seq / 跳刀。
 */
export function applyOrderOverride<T extends CutStep>(
  autoSteps: T[],
  override: OrderOverride | undefined,
  start: Pt = { x: 0, y: 0 },
  anchorKeys?: string[],
  keyOf: (st: T) => string = (st) => stepKey(st),
): { steps: T[]; meta: Omit<OverrideMeta, 'naiveTravelMm'> } {
  const byKey = new Map<string, T>()
  for (const st of autoSteps) byKey.set(keyOf(st), st)
  const autoKeys = autoSteps.map(keyOf)
  const autoRenumbered = renumber(autoSteps, start)
  const autoTravel = totalTravel(autoRenumbered)

  const pinSet = new Set((override?.pinned ?? []).filter((k) => byKey.has(k)))
  const validOrder = (override?.order ?? []).filter((k) => byKey.has(k))
  const staleOrder = (override?.order.length ?? 0) - validOrder.length
  const stalePins = (override?.pinned.length ?? 0) - pinSet.size
  const staleDropped = Math.max(0, staleOrder) + Math.max(0, stalePins)

  let finalSteps: T[]
  if (validOrder.length === 0) {
    // 纯固定模式：固定段保持锚点位置不动，自由段绕开它们重排
    const anchor = (anchorKeys ?? autoKeys).filter((k) => byKey.has(k))
    for (const k of autoKeys) if (!anchor.includes(k)) anchor.push(k)
    const slots: (T | null)[] = anchor.map((k) => (pinSet.has(k) ? byKey.get(k)! : null))
    finalSteps = arrangeByPins(slots, byKey, start, keyOf)
  } else {
    // 手工顺序模式：按手工顺序，缺失段补到队尾
    const seen = new Set<string>()
    finalSteps = []
    for (const k of validOrder) {
      if (seen.has(k)) continue
      seen.add(k)
      finalSteps.push(byKey.get(k)!)
    }
    for (const k of autoKeys) {
      if (!seen.has(k)) finalSteps.push(byKey.get(k)!)
    }
  }

  finalSteps = renumber(finalSteps, start) as T[]
  const keys = finalSteps.map(keyOf)
  let movedCount = 0
  keys.forEach((k, i) => {
    if (autoKeys[i] !== k) movedCount += 1
  })
  const pins: PinSlot[] = []
  keys.forEach((k, i) => {
    if (pinSet.has(k)) pins.push({ key: k, index: i, step: finalSteps[i] })
  })
  const travel = totalTravel(finalSteps)

  return {
    steps: finalSteps,
    meta: {
      manual: validOrder.length > 0 || pinSet.size > 0,
      pins,
      pinnedKeys: [...pinSet],
      keys,
      autoKeys,
      travelMm: travel,
      autoTravelMm: autoTravel,
      extraTravelMm: Math.max(0, travel - autoTravel),
      staleDropped,
      movedCount,
    },
  }
}

/** 列表拖动：把 key 移动到目标下标；固定段之间插入时，新位置落在相邻固定段的间隙内 */
export function moveKey(keys: string[], key: string, toIndex: number): string[] {
  const from = keys.indexOf(key)
  if (from < 0 || toIndex < 0 || toIndex >= keys.length || from === toIndex) return keys
  const next = keys.slice()
  next.splice(from, 1)
  next.splice(toIndex, 0, key)
  return next
}
