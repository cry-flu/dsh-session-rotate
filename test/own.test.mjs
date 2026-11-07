import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, sanitizeConfig, canTouchOwn, archivePlan, trimOwnSessions, OWN_CAP } from '../lib/index.js'

/** 面板提交的最小 payload（与 lib/client.js 的 save() 同形，但只有必填项） */
const payload = (extra = {}) => ({
  defaultMaxSteps: 40,
  confirmEmpty: false,
  workspaces: [{ name: 'my-workspace', maxSteps: null }],
  ...extra,
})

// ---------- autoSwitch：默认开，关掉后保持关 ----------

test('autoSwitch 缺省为 true（与 1.0.0 行为一致）', () => {
  assert.equal(normalizeConfig({}).autoSwitch, true)
  assert.equal(normalizeConfig({ autoSwitch: undefined }).autoSwitch, true)
})

test('autoSwitch=false 能存住，面板不带这个键时沿用旧值', () => {
  // 显式关掉
  assert.equal(normalizeConfig({ autoSwitch: false }).autoSwitch, false)
  // 面板没带 autoSwitch：不能把它冲回 true
  const kept = sanitizeConfig(payload(), { autoSwitch: false })
  assert.equal(kept.autoSwitch, false)
  // 面板带了 autoSwitch=true：跟着提交值
  const back = sanitizeConfig(payload({ autoSwitch: true }), { autoSwitch: false })
  assert.equal(back.autoSwitch, true)
})

// ---------- 默认行为核对：延迟归档缺省 0 ----------

test('deferArchiveMinutes 缺省 0（立即归档，与 1.0.0 一致）', () => {
  assert.equal(normalizeConfig({}).deferArchiveMinutes, 0)
  assert.equal(sanitizeConfig(payload(), undefined).deferArchiveMinutes, 0)
  // 面板提交 0 也不能被当成「空值回落默认」写丢
  assert.equal(sanitizeConfig(payload({ deferArchiveMinutes: 0 }), { deferArchiveMinutes: 5 }).deferArchiveMinutes, 0)
})

// ---------- 安全闸：只认本插件换出来的会话 ----------

test('canTouchOwn 只认登记过的 id', () => {
  const own = new Set(['s-mine'])
  assert.equal(canTouchOwn(own, 's-mine'), true)
  assert.equal(canTouchOwn(own, 's-archived-long-ago'), false)
  assert.equal(canTouchOwn(['s-mine'], 's-mine'), true)
  assert.equal(canTouchOwn(undefined, 's-mine'), false)
  assert.equal(canTouchOwn(own, ''), false)
  assert.equal(canTouchOwn(own, null), false)
})

test('archivePlan：非自己换出的会话一律 none，哪怕开关全开', () => {
  const own = new Set(['s-mine'])
  assert.equal(archivePlan({ archiveOnRotate: true, deferArchiveMinutes: 0 }, own, 's-other'), 'none')
  assert.equal(archivePlan({ archiveOnRotate: true, deferArchiveMinutes: 5 }, own, 's-other'), 'none')
  assert.equal(archivePlan({}, own, 's-other'), 'none')
})

test('archivePlan：三态按开关取值', () => {
  const own = new Set(['s-mine'])
  // 立刻归档
  assert.equal(archivePlan({ archiveOnRotate: true, deferArchiveMinutes: 0 }, own, 's-mine'), 'now')
  // 延迟归档
  assert.equal(archivePlan({ archiveOnRotate: true, deferArchiveMinutes: 5 }, own, 's-mine'), 'deferred')
  // 不归档
  assert.equal(archivePlan({ archiveOnRotate: false, deferArchiveMinutes: 5 }, own, 's-mine'), 'none')
})

// ---------- 三开关组合 ----------

test('组合：不跳转 + 延迟归档（不跳转优先，一律不归档）', () => {
  const cfg = normalizeConfig({ autoSwitch: false, archiveOnRotate: true, deferArchiveMinutes: 5 })
  assert.equal(cfg.autoSwitch, false)
  assert.equal(cfg.archiveOnRotate, true)
  assert.equal(cfg.deferArchiveMinutes, 5)
  // 界面停在旧会话上，归档它就成了「暂时无法查看」→ 计划必须是 none
  assert.equal(archivePlan(cfg, new Set(['s-mine']), 's-mine'), 'none')
})

test('组合：不跳转 + 立即归档（同样不归档）', () => {
  const cfg = normalizeConfig({ autoSwitch: false, archiveOnRotate: true, deferArchiveMinutes: 0 })
  assert.equal(archivePlan(cfg, new Set(['s-mine']), 's-mine'), 'none')
  // 跳转开着时这条路径照常立刻归档，别把正常行为改坏
  const jump = normalizeConfig({ autoSwitch: true, archiveOnRotate: true, deferArchiveMinutes: 0 })
  assert.equal(archivePlan(jump, new Set(['s-mine']), 's-mine'), 'now')
})

// ---------- 回归：关闭自动归档时不动任何已有归档会话 ----------

test('已有一批已归档会话时，关闭自动归档换新：只放过自己换出的那条，其它一条不碰', () => {
  // 用户手动/历史归档的会话：不在 ownSessions 里
  const archivedBefore = ['s-arch-1', 's-arch-2', 's-arch-3']
  const own = new Set(['s-newly-rotated'])

  // 关闭自动归档 → 计划是 none，宿主压根不会被调用
  const plan = archivePlan(
    { archiveOnRotate: false, deferArchiveMinutes: 5 },
    own,
    's-newly-rotated',
  )
  assert.equal(plan, 'none')

  // 归档闸：这批老的归档会话无论走哪条分支都不会被判成「可操作」
  for (const id of archivedBefore) assert.equal(canTouchOwn(own, id), false)
  // 只有本插件换出的那条在册
  assert.equal(canTouchOwn(own, 's-newly-rotated'), true)
  // 已有归档集合本身不被改动（插件没有任何 unarchive 路径）
  assert.deepEqual(archivedBefore, ['s-arch-1', 's-arch-2', 's-arch-3'])
})

// ---------- ownSessions 裁剪：state.json 不无限长，待归档的一个不丢 ----------

test('ownSessions 未超上限时原样返回（顺序不变）', () => {
  const ids = ['s-1', 's-2', 's-3']
  assert.deepEqual(trimOwnSessions(ids, new Set()), ids)
  assert.deepEqual(trimOwnSessions(ids, new Set(), 10), ids)
})

test('超过上限只留最近 N 个，最老的那端被删', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `s-${i}`)
  assert.deepEqual(trimOwnSessions(ids, new Set(), 3), ['s-7', 's-8', 's-9'])
  assert.deepEqual(trimOwnSessions(ids, new Set(), 1), ['s-9'])
})

test('待归档的旧会话被钉住：再老也不删，且顺序不乱', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `s-${i}`)
  // s-0 最老但正在等延迟归档，必须留；cap=3 只保留 s-3..s-5 + s-0
  assert.deepEqual(trimOwnSessions(ids, new Set(['s-0']), 3), ['s-0', 's-3', 's-4', 's-5'])
  // 钉住多个
  assert.deepEqual(trimOwnSessions(ids, ['s-0', 's-2'], 2), ['s-0', 's-2', 's-4', 's-5'])
})

test('裁剪不吃脏数据：非字符串/空串过滤掉，非法 cap 回落默认', () => {
  assert.deepEqual(trimOwnSessions([null, '', 's-1', 42, 's-2'], new Set()), ['s-1', 's-2'])
  assert.deepEqual(trimOwnSessions(undefined, new Set()), [])
  const many = Array.from({ length: OWN_CAP + 5 }, (_, i) => `s-${i}`)
  // cap 传 0 / 负数 / NaN 都回落默认上限，不会把名单清空
  assert.equal(trimOwnSessions(many, new Set(), 0).length, OWN_CAP)
  assert.equal(trimOwnSessions(many, new Set(), -3).length, OWN_CAP)
  assert.equal(trimOwnSessions(many, new Set(), NaN).length, OWN_CAP)
})
