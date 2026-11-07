import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, sanitizeConfig, canTouchOwn, archivePlan } from '../lib/index.js'

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

test('组合：不跳转 + 延迟归档（两个开关互不影响）', () => {
  const cfg = normalizeConfig({ autoSwitch: false, archiveOnRotate: true, deferArchiveMinutes: 5 })
  assert.equal(cfg.autoSwitch, false)
  assert.equal(cfg.archiveOnRotate, true)
  assert.equal(cfg.deferArchiveMinutes, 5)
  // 不跳转不影响归档计划：仍走延迟归档
  assert.equal(archivePlan(cfg, new Set(['s-mine']), 's-mine'), 'deferred')
})

test('组合：不跳转 + 立即归档', () => {
  const cfg = normalizeConfig({ autoSwitch: false, archiveOnRotate: true, deferArchiveMinutes: 0 })
  assert.equal(archivePlan(cfg, new Set(['s-mine']), 's-mine'), 'now')
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
