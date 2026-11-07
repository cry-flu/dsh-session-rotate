import test from 'node:test'
import assert from 'node:assert/strict'
import { decideRotate } from '../lib/decide.js'

test('越限：steps >= limit 直接换，不依赖预判', () => {
  const v = decideRotate({ steps: 41, limit: 40, prevSteps: 20, recentDeltas: [20], minSteps: 10 })
  assert.equal(v.over, true)
  assert.equal(v.shouldRotate, true)
  assert.match(v.reason, /^越限/)
})

test('真首轮无任何历史：沿用保守上界 steps+steps = limit/2', () => {
  const v = decideRotate({ steps: 20, limit: 40, prevSteps: undefined, recentDeltas: [], minSteps: 10 })
  assert.equal(v.estimated, true)
  assert.equal(v.delta, 20)
  assert.equal(v.shouldRotate, true)
  assert.match(v.reason, /首轮预判/)
})

test('真首轮不足 limit/2：不换', () => {
  const v = decideRotate({ steps: 19, limit: 40, prevSteps: undefined, recentDeltas: [], minSteps: 10 })
  assert.equal(v.shouldRotate, false)
  assert.equal(v.reason, null)
})

test('跨会话历史：新会话首轮就按均值+1 预判，不再退化成 steps+steps', () => {
  const v = decideRotate({ steps: 12, limit: 40, prevSteps: undefined, recentDeltas: [6, 6, 6], minSteps: 10 })
  assert.equal(v.measured, null) // 新会话没有上一轮
  assert.equal(v.estimated, false)
  assert.equal(v.avg, 6)
  assert.equal(v.delta, 7)
  assert.equal(v.shouldRotate, false) // 12 + 7 = 19 < 40
})

test('跨会话历史能把预判推过线', () => {
  const v = decideRotate({ steps: 20, limit: 30, prevSteps: undefined, recentDeltas: [12, 12, 12], minSteps: 10 })
  assert.equal(v.delta, 13)
  assert.equal(v.shouldRotate, true)
  assert.match(v.reason, /近3轮均值12\.0\+1/)
})

test('窗口只取最后 3 个增量', () => {
  const v = decideRotate({ steps: 12, limit: 40, prevSteps: 6, recentDeltas: [100, 1, 2, 3], minSteps: 0 })
  assert.deepEqual(v.window, [2, 3, 6]) // 前 100 被挤出窗口
  assert.equal(v.measured, 6)
  assert.equal(v.avg, 11 / 3)
  assert.equal(v.delta, 5) // round(3.67) + 1
  assert.equal(v.shouldRotate, false) // 12 + 5 = 17 < 40
})

test('minSteps 压住越限与预判', () => {
  const over = decideRotate({ steps: 5, limit: 4, prevSteps: 1, recentDeltas: [], minSteps: 10 })
  assert.equal(over.over, true)
  assert.equal(over.shouldRotate, false)
  assert.equal(over.blocked, 'minSteps')

  const pred = decideRotate({ steps: 8, limit: 10, prevSteps: 2, recentDeltas: [6, 6], minSteps: 20 })
  assert.equal(pred.shouldRotate, false)
  assert.equal(pred.blocked, 'minSteps')
})

test('minSteps=0 或非数字 = 关掉这道闸', () => {
  for (const minSteps of [0, undefined, null, 'x']) {
    const v = decideRotate({ steps: 4, limit: 4, prevSteps: 1, recentDeltas: [], minSteps })
    assert.equal(v.minSteps, 0)
    assert.equal(v.shouldRotate, true, `minSteps=${minSteps} 时该照常换`)
  }
})

test('steps 倒退（宿主重算）时不做实测增量，避免负数进窗口', () => {
  const v = decideRotate({ steps: 5, limit: 40, prevSteps: 30, recentDeltas: [3], minSteps: 0 })
  assert.equal(v.measured, null)
  assert.deepEqual(v.window, [3])
})

test('limit 非法：一律不换', () => {
  const v = decideRotate({ steps: 100, limit: Number.NaN, prevSteps: 1, recentDeltas: [], minSteps: 0 })
  assert.equal(v.shouldRotate, false)
})
