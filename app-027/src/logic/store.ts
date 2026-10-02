import { reactive, watch } from 'vue'
import {
  DEFAULT_CUT_SETTINGS,
  DEFAULT_EXPORT_CFG,
  DEFAULT_SHEET,
  type BatchCfg,
  type ContourWarning,
  type CutSettings,
  type ExportCfg,
  type MaterialPreset,
  type OrderOverride,
  type Project,
  type Shape,
  type Sheet,
} from './types'
import { computeShape, shapeSignature, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import { applyOrderOverride, moveKey } from './manualOrder'
import { uid } from './geometry'
import { importSvgText, type ImportResult } from './importer'
import { defaultMaterials } from '@/data/materials'

const LS_KEY = 'papercut-plotter-studio/v1'

type Persisted = {
  version: number
  projects: Project[]
  materials: MaterialPreset[]
}

type StoreState = {
  projects: Project[]
  materials: MaterialPreset[]
  ready: boolean
  lastError: string | null
}

export const state = reactive<StoreState>({
  projects: [],
  materials: [],
  ready: false,
  lastError: null,
})

/** 派生计算结果缓存（按几何签名失效，不持久化） */
const computedCache = reactive<Record<string, ComputedShape>>({})
const batchCache = new Map<string, ComputedShape>()

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function loadState(): void {
  state.materials = defaultMaterials()
  if (!canUseStorage()) {
    state.ready = true
    return
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Persisted
      if (parsed && Array.isArray(parsed.projects)) {
        state.projects = parsed.projects.map(normalizeProject)
      }
      if (parsed && Array.isArray(parsed.materials) && parsed.materials.length > 0) {
        state.materials = parsed.materials.map((m) => ({ ...m, backing: m.backing ?? '常规垫板' }))
      }
    }
  } catch (e) {
    state.lastError = `本地数据读取失败：${(e as Error).message}`
  }
  state.ready = true
  recomputeAll()
}

export function saveNow(): void {
  if (!canUseStorage()) return
  try {
    const data: Persisted = { version: 1, projects: state.projects, materials: state.materials }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch (e) {
    state.lastError = `本地保存失败：${(e as Error).message}`
  }
}

let saveTimer: number | null = null
export function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 250)
}

function normalizeProject(p: Project): Project {
  return {
    ...p,
    settings: { ...DEFAULT_CUT_SETTINGS, ...(p.settings ?? {}) },
    export: { ...DEFAULT_EXPORT_CFG, ...(p.export ?? {}) },
    sheet: p.sheet ?? { ...DEFAULT_SHEET },
    shapes: (p.shapes ?? []).map((s) => ({
      ...s,
      contours: (s.contours ?? []).map((c) => ({ ...c, holes: c.holes ?? [], bridges: c.bridges ?? [], warnings: c.warnings ?? [] })),
    })),
    layerNames: p.layerNames ?? ['图层 1'],
    orderOverride: p.orderOverride ? { order: p.orderOverride.order ?? [], pinned: p.orderOverride.pinned ?? [] } : undefined,
  }
}

export function materialOf(p: Project): MaterialPreset | null {
  return state.materials.find((m) => m.id === p.materialId) ?? state.materials[0] ?? null
}

/** 重算派生数据（清理结果 → 连刀点 → 刀补 → 包含树 → 切割顺序） */
export function recomputeProject(p: Project, force = false): void {
  const material = materialOf(p)
  for (const shape of p.shapes) {
    const sig = shapeSignature(shape, p.settings, material)
    const cached = computedCache[shape.id]
    if (!force && cached && cached.signature === sig) continue
    const res = computeShape(shape, p.settings, material)
    applyComputed(shape, res)
    computedCache[shape.id] = res
  }
}

export function recomputeAll(force = false): void {
  for (const p of state.projects) recomputeProject(p, force)
}

/** 回写清理/派生警告（连刀点中只有手工放置的保存在数据模型里） */
function applyComputed(shape: Shape, res: ComputedShape): void {
  for (const c of shape.contours) {
    const base = c.warnings.filter(
      (w) => w === 'not_closed' || w === 'self_intersect' || w === 'duplicate' || w === 'too_short',
    ) as ContourWarning[]
    const extra = res.warningUpdates.get(c.id) ?? []
    c.warnings = [...base, ...extra.filter((w) => !base.includes(w))]
  }
}

export function computedOf(shapeId: string): ComputedShape | null {
  return computedCache[shapeId] ?? null
}

/** 应用项目级手工顺序覆盖（拖动 / 固定），返回可能被重排过的新 Job */
function withOrderOverride(job: Job, p: Project, start: { x: number; y: number }): Job {
  const ov = p.orderOverride
  if (!ov || (ov.order.length === 0 && ov.pinned.length === 0)) return job
  const { steps, meta } = applyOrderOverride(job.steps, ov, start, undefined, (s) => s.okey)
  return {
    ...job,
    steps,
    travelMm: meta.travelMm,
    cutLengthMm: job.cutLengthMm,
    runCount: steps.length,
    orderMeta: { ...meta, naiveTravelMm: job.naiveTravelMm },
  }
}

/** 排版任务：批量排版开启时只排所选纹样，否则排全部形状 */
export function jobOf(p: Project): { job: Job; shape: Shape | null; isBatch: boolean; computed: Map<string, ComputedShape> } {
  const material = materialOf(p)
  const start = { x: 0, y: 0 }
  const batch = p.batch
  if (batch && batch.enabled) {
    const src = p.shapes.find((s) => s.id === p.batchShapeId) ?? p.shapes[0]
    if (src) {
      const tiled = buildBatchShape(src, batch)
      const sig = `batch|${shapeSignature(src, p.settings, material)}|${batch.rows}|${batch.cols}|${batch.gapXMm}|${batch.gapYMm}|${batch.mode}`
      let comp = batchCache.get(sig)
      if (!comp) {
        comp = computeShape(tiled, p.settings, material, start)
        batchCache.set(sig, comp)
        if (batchCache.size > 24) {
          const firstKey = batchCache.keys().next().value
          if (firstKey !== undefined) batchCache.delete(firstKey)
        }
      }
      const map = new Map<string, ComputedShape>([[tiled.id, comp]])
      const baseJob = buildJob([tiled], map, layerOrderOf(p), { sharedEdge: batch.sharedEdge, start })
      const job = withOrderOverride(baseJob, p, start)
      return { job, shape: tiled, isBatch: true, computed: map }
    }
  }
  recomputeProject(p)
  const map = new Map<string, ComputedShape>()
  for (const s of p.shapes) {
    const c = computedCache[s.id]
    if (c) map.set(s.id, c)
  }
  const baseJob = buildJob(p.shapes, map, layerOrderOf(p), { sharedEdge: false, start })
  const job = withOrderOverride(baseJob, p, start)
  return { job, shape: null, isBatch: false, computed: map }
}

export function layerOrderOf(p: Project): number[] {
  const set = new Set(p.shapes.map((s) => s.layer))
  return Array.from(set).sort((a, b) => a - b)
}

// ---------------- 项目与形状操作 ----------------

function newProject(name: string, shapes: Shape[]): Project {
  const now = Date.now()
  return {
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    shapes,
    settings: { ...DEFAULT_CUT_SETTINGS },
    export: { ...DEFAULT_EXPORT_CFG },
    sheet: { ...DEFAULT_SHEET },
    materialId: state.materials[0]?.id ?? '',
    layerNames: ['图层 1'],
    batch: { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' },
  }
}

export function createProjectFromShapes(name: string, shapes: Shape[]): Project {
  const p = newProject(name, shapes)
  state.projects.unshift(p)
  recomputeProject(p, true)
  scheduleSave()
  return p
}

export function createBlankProject(name: string): Project {
  return createProjectFromShapes(name, [{ id: uid('s'), name: '新建形状', contours: [], layer: 0 }])
}

export function getProject(id: string): Project | undefined {
  return state.projects.find((p) => p.id === id)
}

export function deleteProject(id: string): void {
  const i = state.projects.findIndex((p) => p.id === id)
  if (i >= 0) {
    state.projects.splice(i, 1)
    scheduleSave()
  }
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const copy: Project = JSON.parse(JSON.stringify(src))
  copy.id = uid('p')
  copy.name = `${src.name} 副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  // 重新分配 id，避免缓存串用
  for (const s of copy.shapes) {
    s.id = uid('s')
    for (const c of s.contours) c.id = uid('c')
    for (const c of s.contours) {
      c.holes = []
      c.bridges = []
    }
  }
  state.projects.unshift(copy)
  recomputeProject(copy, true)
  scheduleSave()
  return copy
}

export function touch(p: Project): void {
  p.updatedAt = Date.now()
  scheduleSave()
}

export function addShape(p: Project, shape: Shape): void {
  p.shapes.push(shape)
  recomputeProject(p, true)
  touch(p)
}

export function removeShape(p: Project, shapeId: string): void {
  const i = p.shapes.findIndex((s) => s.id === shapeId)
  if (i >= 0) {
    p.shapes.splice(i, 1)
    delete computedCache[shapeId]
    touch(p)
  }
}

export function updateSettings(p: Project, patch: Partial<CutSettings>): void {
  Object.assign(p.settings, patch)
  recomputeProject(p, true)
  touch(p)
}

export function updateExport(p: Project, patch: Partial<ExportCfg>): void {
  Object.assign(p.export, patch)
  touch(p)
}

export function updateSheet(p: Project, sheet: Sheet): void {
  p.sheet = { ...sheet }
  touch(p)
}

export function updateBatch(p: Project, patch: Partial<BatchCfg>): void {
  if (!p.batch) p.batch = { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' }
  Object.assign(p.batch, patch)
  touch(p)
}

export function setMaterial(p: Project, materialId: string): void {
  p.materialId = materialId
  recomputeProject(p, true)
  touch(p)
}

/** 一键闭合所有未闭合轮廓 */
export function closeAllOpen(p: Project): number {
  let n = 0
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (!c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        n += 1
      }
    }
  }
  if (n > 0) {
    recomputeProject(p, true)
    touch(p)
  }
  return n
}

export function closeContour(p: Project, contourId: string): boolean {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id === contourId && !c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        recomputeProject(p, true)
        touch(p)
        return true
      }
    }
  }
  return false
}

export function removeContour(p: Project, contourId: string): void {
  for (const shape of p.shapes) {
    const i = shape.contours.findIndex((c) => c.id === contourId)
    if (i >= 0) {
      shape.contours.splice(i, 1)
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

/** 手工放置连刀点：在指定轮廓上离 p 最近的顶点处 */
export function placeManualBridge(p: Project, contourId: string, atIndex: number): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id !== contourId) continue
      if (!c.bridges.some((b) => b.atIndex === atIndex)) {
        c.bridges.push({ atIndex, widthMm: p.settings.bridgeWidthMm })
      }
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

export function clearManualBridges(p: Project, contourId?: string): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (contourId && c.id !== contourId) continue
      c.bridges = []
    }
  }
  recomputeProject(p, true)
  touch(p)
}

/** 纹样对称生成：镜像 / 旋转 / 四方连续 */
export function applySymmetry(p: Project, shapeId: string, op: 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'): void {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return
  const all = shape.contours.flatMap((c) => c.points)
  if (all.length === 0) return
  const minX = Math.min(...all.map((q) => q.x))
  const maxX = Math.max(...all.map((q) => q.x))
  const minY = Math.min(...all.map((q) => q.y))
  const maxY = Math.max(...all.map((q) => q.y))

  const makeCopy = (fn: (x: number, y: number) => { x: number; y: number }): Shape => {
    const contours = shape.contours.map((c) => {
      const pts = c.points.map((q) => {
        const r = fn(q.x, q.y)
        return { x: Math.round(r.x * 1000) / 1000, y: Math.round(r.y * 1000) / 1000 }
      })
      return { ...c, id: uid('c'), points: pts, holes: [], bridges: [], warnings: [] }
    })
    return { id: uid('s'), name: `${shape.name} 对称`, contours, layer: shape.layer }
  }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const ops: Array<(x: number, y: number) => { x: number; y: number }> = []
  if (op === 'mirror_x') ops.push((x, y) => ({ x: minX + maxX - x, y }))
  if (op === 'mirror_y') ops.push((x, y) => ({ x, y: minY + maxY - y }))
  if (op === 'rotate_90') ops.push((x, y) => ({ x: cx - (y - cy), y: cy + (x - cx) }))
  if (op === 'rotate_180') ops.push((x, y) => ({ x: 2 * cx - x, y: 2 * cy - y }))
  if (op === 'four_way') {
    ops.push((x, y) => ({ x: minX + maxX - x, y }))
    ops.push((x, y) => ({ x, y: minY + maxY - y }))
    ops.push((x, y) => ({ x: minX + maxX - x, y: minY + maxY - y }))
  }
  for (const fn of ops) p.shapes.push(makeCopy(fn))
  recomputeProject(p, true)
  touch(p)
}

// ---------------- 手工切割顺序 ----------------

function overrideOf(p: Project): OrderOverride {
  if (!p.orderOverride) p.orderOverride = { order: [], pinned: [] }
  return p.orderOverride
}

/** 取当前生效顺序的 key 列表（有手工干预时为手工顺序，否则为自动顺序） */
export function effectiveOrderKeys(p: Project): string[] {
  const { job } = jobOf(p)
  return job.steps.map((s) => s.okey)
}

/** 拖动：把某段移到目标位置（首次拖动时以自动顺序为基准） */
export function reorderCutStep(p: Project, key: string, toIndex: number): void {
  const ov = overrideOf(p)
  const base = ov.order.length > 0 ? ov.order : effectiveOrderKeys(p)
  ov.order = moveKey(base, key, toIndex)
  touch(p)
}

/** 固定 / 取消固定某段（固定位置 = 当前生效位置；纯固定模式下重排会绕开它） */
export function pinCutStep(p: Project, key: string, pinned: boolean): void {
  const ov = overrideOf(p)
  const pinnedSet = new Set(ov.pinned)
  if (pinned) pinnedSet.add(key)
  else pinnedSet.delete(key)
  // 固定集合按当前生效顺序排列，使 applyOrderOverride 的锚点槽位与画面一致
  const cur = effectiveOrderKeys(p)
  ov.pinned = cur.filter((k) => pinnedSet.has(k))
  touch(p)
}

/**
 * 绕开固定段重新就近优化：固定段位置不动，其余自由段重排。
 * 固定槽位以当前生效顺序为锚，重排结果写回手工顺序（可继续拖动 / 退回自动）。
 */
export function optimizeAroundPins(p: Project): void {
  const ov = overrideOf(p)
  if (ov.pinned.length === 0) return
  const { job } = jobOf(p)
  const curKeys = job.steps.map((s) => s.okey)
  const { steps } = applyOrderOverride(job.steps, { order: [], pinned: ov.pinned }, { x: 0, y: 0 }, curKeys, (s) => s.okey)
  ov.order = steps.map((s) => s.okey)
  touch(p)
}

/** 一键退回自动结果（清空手工顺序与固定） */
export function resetCutOrder(p: Project): void {
  p.orderOverride = { order: [], pinned: [] }
  touch(p)
}

// ---------------- 材料预设 ----------------

export function upsertMaterial(m: MaterialPreset): void {
  const i = state.materials.findIndex((x) => x.id === m.id)
  if (i >= 0) state.materials[i] = { ...m }
  else state.materials.push({ ...m })
  scheduleSave()
}

export function deleteMaterial(id: string): void {
  const i = state.materials.findIndex((x) => x.id === id)
  if (i >= 0 && state.materials.length > 1) {
    state.materials.splice(i, 1)
    for (const p of state.projects) {
      if (p.materialId === id) {
        p.materialId = state.materials[0].id
        recomputeProject(p, true)
      }
    }
    scheduleSave()
  }
}

// ---------------- 导入 ----------------

export function importSvgToShapes(
  text: string,
  name: string,
  settings: CutSettings,
): { result: ImportResult; shape: Shape } {
  const result = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const shape: Shape = { id: uid('s'), name, contours: result.contours, layer: 0 }
  return { result, shape }
}

export function addImportedShapes(p: Project, shapes: Shape[]): void {
  for (const s of shapes) p.shapes.push(s)
  recomputeProject(p, true)
  touch(p)
}

watch(
  () => [state.projects, state.materials],
  () => {
    if (state.ready) scheduleSave()
  },
  { deep: true },
)

export const store = {
  state,
  loadState,
  saveNow,
  scheduleSave,
  materialOf,
  getProject,
  computedOf,
  jobOf,
  layerOrderOf,
  createProjectFromShapes,
  createBlankProject,
  deleteProject,
  duplicateProject,
  addShape,
  addImportedShapes,
  removeShape,
  updateSettings,
  updateExport,
  updateSheet,
  updateBatch,
  setMaterial,
  closeAllOpen,
  closeContour,
  removeContour,
  placeManualBridge,
  clearManualBridges,
  applySymmetry,
  upsertMaterial,
  deleteMaterial,
  recomputeProject,
  recomputeAll,
  importSvgToShapes,
  touch,
  effectiveOrderKeys,
  reorderCutStep,
  pinCutStep,
  optimizeAroundPins,
  resetCutOrder,
}