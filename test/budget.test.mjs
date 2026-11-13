import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetBand, budgetHintText, numberedTitle, BUDGET_SOFT } from '../lib/index.js'

test('budgetBand：不到软线不吭声', () => {
  assert.equal(budgetBand(0, 60), 'none')
  assert.equal(budgetBand(47, 60), 'none') // 47/60 = 78.3% < 80%
  assert.equal(budgetBand(48, 60), 'near') // 48/60 = 80%
  assert.equal(budgetBand(59, 60), 'near')
  assert.equal(budgetBand(60, 60), 'over')
  assert.equal(budgetBand(237, 60), 'over')
})

test('budgetBand：配置残缺时不误报', () => {
  assert.equal(budgetBand(undefined, 60), 'none')
  assert.equal(budgetBand(10, undefined), 'none')
  assert.equal(budgetBand(10, 0), 'none')
  assert.equal(budgetBand(10, -5), 'none')
  assert.equal(budgetBand('12', '60'), 'none') // 12/60 = 20%
  assert.equal(BUDGET_SOFT, 0.8)
})

test('budgetHintText：不到软线返回空串（不占上下文）', () => {
  assert.equal(budgetHintText(10, 60), '')
  assert.equal(budgetHintText(47, 60), '')
})

test('budgetHintText：软提醒报出步数，并要求主动建议新开', () => {
  const text = budgetHintText(50, 60)
  assert.match(text, /50\/60/)
  assert.match(text, /新开一个会话/)
  assert.match(text, /接近上限/)
})

test('budgetHintText：到上限时说明本轮结束后会换新', () => {
  const text = budgetHintText(60, 60)
  assert.match(text, /60\/60/)
  assert.match(text, /换/)
  const over = budgetHintText(237, 60)
  assert.match(over, /237\/60/)
})

test('numberedTitle：加序号、剥序号、按工作区顺序', () => {
  assert.equal(numberedTitle('修插件', 2), '[#2] 修插件')
  assert.equal(numberedTitle('[#3] 修插件', 2), '[#2] 修插件')
  assert.equal(numberedTitle('[#3] 修插件', 0), '修插件')
  assert.equal(numberedTitle('  修插件  ', undefined), '修插件')
})

test('numberedTitle：接续/收尾带标签与时间', () => {
  assert.equal(numberedTitle('修插件', 4, { tag: '接续', stamp: '02:30' }), '[#4] 接续 · 修插件 @ 02:30')
  assert.equal(numberedTitle('[#1] 修插件', 2, { tag: '收尾' }), '[#2] 收尾 · 修插件')
})

test('numberedTitle：标题过长会截断，空标题不炸', () => {
  const long = 'x'.repeat(200)
  const out = numberedTitle(long, 1)
  assert.ok(out.length <= 10 + 60)
  assert.equal(numberedTitle('', 1), '[#1]')
  assert.equal(numberedTitle(null, 0), '')
})
