import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, sanitizeConfig, configWarnings, workspaceOverrides, clipReply } from '../lib/index.js'

/** 桌面面板实际提交的 payload：只有 defaultMaxSteps / confirmEmpty / workspaces */
const panelPayload = (workspaces = [{ name: 'my-workspace', maxSteps: null }]) => ({
  defaultMaxSteps: 40,
  confirmEmpty: false,
  workspaces,
})

test('面板只提交上限时，试运行与三道保护闸保持文件里的值（回归）', () => {
  const prev = { defaultMaxSteps: 40, workspaces: [{ name: 'my-workspace', maxSteps: null }], minSteps: 7, cooldownMinutes: 3, maxRotations: 5, dryRun: true }
  const next = sanitizeConfig(panelPayload(), prev)
  assert.equal(next.minSteps, 7)
  assert.equal(next.cooldownMinutes, 3)
  assert.equal(next.maxRotations, 5)
  assert.equal(next.dryRun, true)
})

test('面板带了新值就用提交值', () => {
  const prev = { minSteps: 7, cooldownMinutes: 3, maxRotations: 5, dryRun: true }
  const next = sanitizeConfig({ ...panelPayload(), minSteps: 12, cooldownMinutes: 15, maxRotations: 2, dryRun: false }, prev)
  assert.equal(next.minSteps, 12)
  assert.equal(next.cooldownMinutes, 15)
  assert.equal(next.maxRotations, 2)
  assert.equal(next.dryRun, false)
})

test('没有旧配置时回落默认（10 / 10 / 3 / 关）', () => {
  const next = sanitizeConfig(panelPayload(), undefined)
  assert.deepEqual(
    { minSteps: next.minSteps, cooldownMinutes: next.cooldownMinutes, maxRotations: next.maxRotations, dryRun: next.dryRun },
    { minSteps: 10, cooldownMinutes: 10, maxRotations: 3, dryRun: false },
  )
})

test('工作区的保护闸覆盖项不会被面板保存冲掉', () => {
  const prev = {
    defaultMaxSteps: 40,
    workspaces: [{ name: 'my-workspace', maxSteps: 20, minSteps: 5, cooldownMinutes: 2, maxRotations: 1 }],
  }
  const next = sanitizeConfig(panelPayload(), prev)
  assert.deepEqual(next.workspaces[0], { name: 'my-workspace', maxSteps: null, minSteps: 5, cooldownMinutes: 2, maxRotations: 1 })
})

test('maxSteps 留空 = null（跟随默认），非法值丢弃', () => {
  const next = sanitizeConfig({ defaultMaxSteps: '30', workspaces: [{ name: 'a', maxSteps: '' }, { name: 'b', maxSteps: 'x' }, { name: 'c', maxSteps: 12 }] }, {})
  assert.equal(next.defaultMaxSteps, 30)
  assert.deepEqual(next.workspaces.map((w) => w.maxSteps), [null, null, 12])
})

test('工作区名去重、空名丢弃', () => {
  const next = sanitizeConfig({ workspaces: [{ name: 'a' }, { name: ' a ' }, { name: '  ' }, { nope: 1 }] }, {})
  assert.deepEqual(next.workspaces, [{ name: 'a', maxSteps: null }])
})

test('workspaceOverrides 只认显式数字，0 对 minSteps 有效', () => {
  assert.deepEqual(workspaceOverrides({ minSteps: 0 }), { minSteps: 0 })
  assert.deepEqual(workspaceOverrides({ minSteps: null, cooldownMinutes: '' }), {})
  assert.deepEqual(workspaceOverrides({ cooldownMinutes: 0, maxRotations: -1 }), {})
})

test('normalizeConfig：空 maxSteps 跟随默认，overrides 按工作区归位', () => {
  const cfg = normalizeConfig({
    defaultMaxSteps: 25,
    minSteps: 0,
    workspaces: [{ name: 'a', maxSteps: null }, { name: 'b', maxSteps: 8, cooldownMinutes: 1 }],
  })
  assert.equal(cfg.def, 25)
  assert.equal(cfg.map.get('a'), 25)
  assert.equal(cfg.map.get('b'), 8)
  assert.equal(cfg.minSteps, 0)
  assert.deepEqual(cfg.overrides.get('b'), { cooldownMinutes: 1 })
  assert.equal(cfg.overrides.has('a'), false)
})

test('configWarnings：上限低于最低步数时给提示（默认与按工作区各一条）', () => {
  const defLow = configWarnings(normalizeConfig({ defaultMaxSteps: 5, minSteps: 10, workspaces: [{ name: 'a', maxSteps: null }] }))
  assert.equal(defLow.length, 1)
  assert.match(defLow[0], /默认上限 5 步 < 最低步数 10/)

  const wsLow = configWarnings(normalizeConfig({ defaultMaxSteps: 40, minSteps: 10, workspaces: [{ name: 'b', maxSteps: 6 }] }))
  assert.equal(wsLow.length, 1)
  assert.match(wsLow[0], /工作区「b」/)

  assert.deepEqual(configWarnings(normalizeConfig({ defaultMaxSteps: 40, minSteps: 10, workspaces: [{ name: 'c', maxSteps: 20 }] })), [])
})

test('archiveOnRotate 默认开；显式 false 才不归档旧会话', () => {
  assert.equal(normalizeConfig({}).archiveOnRotate, true)
  assert.equal(normalizeConfig({ archiveOnRotate: false }).archiveOnRotate, false)
  const kept = sanitizeConfig(panelPayload(), { archiveOnRotate: false })
  assert.equal(kept.archiveOnRotate, false)
  const flipped = sanitizeConfig({ ...panelPayload(), archiveOnRotate: false }, { archiveOnRotate: true })
  assert.equal(flipped.archiveOnRotate, false)
})

test('clipReply：没超长就整段照贴，超长才头尾各留一段', () => {
  const short = '一'.repeat(4000)
  assert.equal(clipReply(short), short)
  const long = clipReply('头'.repeat(6000) + '尾'.repeat(1000))
  assert.ok(long.startsWith('头'))
  assert.ok(long.endsWith('尾'))
  assert.ok(long.includes('中间省略'))
  assert.ok(long.length < 4200)
})
