import { applyOrderOverride, moveKey, stepKey } from '../src/logic/manualOrder.ts'
import type { CutStep } from '../src/logic/order.ts'
import type { Pt } from '../src/logic/types.ts'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failures += 1
}

function mkStep(id: string, runIndex: number, x: number, y: number): CutStep {
  const startPt: Pt = { x, y }
  const endPt: Pt = { x: x + 1, y }
  return {
    seq: 0,
    contourId: id,
    runIndex,
    runCount: 1,
    points: [startPt, endPt],
    closed: false,
    startPt,
    endPt,
    travelFromPrevMm: 0,
    level: 1,
    layer: 0,
    lengthMm: 1,
  }
}

// 8 个点在 x 轴 10mm 间隔排列，自动顺序应为 0..7（跳刀最小）
const raw: CutStep[] = []
for (let i = 0; i < 8; i++) raw.push(mkStep(`c${i}`, 0, i * 10, 0))
const auto = raw.map((st, i) => ({ ...st, seq: i + 1, travelFromPrevMm: i === 0 ? 0 : 9 }))

// 1) 无覆盖：原样返回
let r = applyOrderOverride(auto, undefined)
check('无覆盖=自动顺序', r.meta.manual === false && r.meta.travelMm === 63, `travel=${r.meta.travelMm}`)

// 2) 手工拖动：把 c0 拖到最后
let order = auto.map(stepKey)
order = moveKey(order, 'c0#0', 7)
r = applyOrderOverride(auto, { order, pinned: [] })
check('拖动后顺序生效', r.steps[7].contourId === 'c0' && r.steps[0].contourId === 'c1', `首=${r.steps[0].contourId} 尾=${r.steps[7].contourId}`)
check('拖动多走跳刀>0', r.meta.extraTravelMm > 0, `extra=${r.meta.extraTravelMm.toFixed(1)}mm`)
check('movedCount 正确', r.meta.movedCount >= 2, `moved=${r.meta.movedCount}`)
check('seq 与 travel 重算', r.steps[0].travelFromPrevMm === 0 && Math.abs(r.steps[r.steps.length - 1].travelFromPrevMm - 71) < 1e-9)

// 3) 固定最后一段 c7 在原位，纯固定覆盖：重排绕开它且它不动
r = applyOrderOverride(auto, { order: [], pinned: ['c7#0'] })
const i7 = r.steps.findIndex((s) => s.contourId === 'c7')
check('固定段停在槽位 7（最后）', i7 === 7, `index=${i7}`)
check('纯固定且自动最优时 travel 不变', Math.abs(r.meta.travelMm - 63) < 1e-9, `travel=${r.meta.travelMm}`)
check('固定元信息', r.meta.pins.length === 1 && r.meta.pinnedKeys[0] === 'c7#0')

// 4) 固定锚点换成「乱序」里的槽位：把 c0 固定在中间（锚点为乱序），重排后其余段就近
const anchor = ['c3#0', 'c2#0', 'c1#0', 'c0#0', 'c4#0', 'c5#0', 'c6#0', 'c7#0']
r = applyOrderOverride(auto, { order: [], pinned: ['c0#0'] }, { x: 0, y: 0 }, anchor)
const i0 = r.steps.findIndex((s) => s.contourId === 'c0')
check('固定段锚在指定槽位 3', i0 === 3, `index=${i0}`)
check('绕开固定后自由段仍覆盖全部 8 段', new Set(r.steps.map(stepKey)).size === 8)
check('绕开固定比自动多走', r.meta.extraTravelMm >= 0, `extra=${r.meta.extraTravelMm.toFixed(1)}`)

// 5) 固定多段：c2 在槽 2、c6 在槽 6
r = applyOrderOverride(auto, { order: [], pinned: ['c2#0', 'c6#0'] })
check('两个固定段槽位正确', r.steps[2].contourId === 'c2' && r.steps[6].contourId === 'c6')
check('固定段之间自由段补齐', r.steps.length === 8 && r.meta.pins.length === 2)

// 6) 几何变化：自动序列少了 c3、多了 c9，旧手工顺序引用 c3 应被丢弃，c9 补队尾
const changed = auto.filter((s) => s.contourId !== 'c3').map((s) => ({ ...s }))
changed.push(mkStep('c9', 0, 90, 0))
r = applyOrderOverride(changed, { order: ['c3#0', 'c0#0', 'c1#0'], pinned: ['c3#0', 'c0#0'] })
check('失效 key 被丢弃计数', r.meta.staleDropped === 2, `stale=${r.meta.staleDropped}`)
check('新出现段补入', r.steps.some((s) => s.contourId === 'c9'))
check('旧手工顺序保留部分仍生效', r.steps[0].contourId === 'c0' && r.steps[1].contourId === 'c1')
check('失效固定不残留', !r.meta.pinnedKeys.includes('c3#0') && r.meta.pinnedKeys.includes('c0#0'))

// 7) 手工模式下固定只作标识，顺序完全按手工
r = applyOrderOverride(auto, { order: ['c7#0', 'c6#0', 'c5#0', 'c4#0', 'c3#0', 'c2#0', 'c1#0', 'c0#0'], pinned: ['c0#0'] })
check('手工完全逆序', r.steps[0].contourId === 'c7' && r.steps[7].contourId === 'c0')
check('逆序跳刀正确', Math.abs(r.steps[1].travelFromPrevMm - 11) < 1e-9 && r.meta.travelMm === 77, `travel=${r.meta.travelMm}`)

// 8) moveKey 边界
check('moveKey 越界不改动', moveKey(order, 'c0#0', 99).length === 8)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
