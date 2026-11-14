import test from 'node:test'
import assert from 'node:assert/strict'
import { handoffModeOf, renderHandoffTail, summaryText } from '../lib/index.js'

const user = (text, kind = 'user') => ({
  type: 'user/message',
  data: { message: { role: 'user', content: [{ type: 'text', text }], source: kind === null ? undefined : { kind } } },
})
const assistant = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'assistant' } } },
})
const call = (name, args = {}) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
const session = (id, events) => ({ id, ownEvents: () => events })

// ---------- 交接形式：非法值一律回落 summary ----------

test('handoffModeOf：三档透传，其它回落 summary', () => {
  assert.equal(handoffModeOf('summary'), 'summary')
  assert.equal(handoffModeOf('tail'), 'tail')
  assert.equal(handoffModeOf('id'), 'id')
  assert.equal(handoffModeOf('TAIL'), 'summary')
  assert.equal(handoffModeOf(undefined), 'summary')
  assert.equal(handoffModeOf(''), 'summary')
})

// ---------- summary 档：不传 opts 时行为与 1.6.0 之前一致 ----------

test('summaryText：缺省仍是 12 行状态摘要', () => {
  const s = session('sess-old', [user('把 build 修好'), assistant('未完成：等 CI')])
  const text = summaryText(s, { title: 'demo' }, 41, 40, '越限', { archiveOnRotate: false })
  assert.ok(text.startsWith('【会话交接 · 自动】'))
  assert.ok(text.includes('当前目标：把 build 修好'))
  assert.ok(text.includes('旧会话：sess-old'))
  assert.ok(text.split('\n').length <= 14)
})

// ---------- tail 档：只给 id + 尾条路径 + 两行锚 ----------

test('summaryText：tail 档只带 id、尾条路径、目标与未完成', () => {
  const s = session('sess-old', [user('把 build 修好'), assistant('第一段。\n\n未完成：release 还没跑')])
  const text = summaryText(s, { title: 'demo' }, 41, 40, '越限', { archiveOnRotate: true }, {
    mode: 'tail',
    tailPath: 'C:\\dsh\\handoff\\sess-old.txt',
  })
  const lines = text.split('\n')
  assert.equal(lines.length, 6, '尾条档固定 6 行')
  assert.equal(lines[0], '【会话交接 · 自动】')
  assert.ok(lines[1].includes('旧会话：sess-old'))
  assert.equal(lines[2], '尾条：C:\\dsh\\handoff\\sess-old.txt')
  assert.ok(lines[3].includes('.zstd'), '要明确别去解会话文件')
  assert.ok(lines[4].startsWith('当前目标：'))
  assert.ok(lines[5].startsWith('未完成：'))
  assert.ok(!text.includes('最近改动'), '尾条档不再带三行状态')
  assert.ok(!text.includes('更早的用户指令'))
})

test('summaryText：tail 档落盘失败时说明改回摘要，不留空路径', () => {
  const s = session('sess-old', [user('x')])
  const text = summaryText(s, { title: 'demo' }, 1, 1, '越限', {}, { mode: 'tail', tailPath: '' })
  assert.ok(text.includes('尾条：（落盘失败，改用摘要）'))
})

// ---------- id 档：只给 id ----------

test('summaryText：id 档只给会话 id', () => {
  const s = session('sess-old', [user('x'), assistant('y'.repeat(500))])
  const text = summaryText(s, { title: 'demo' }, 41, 40, '越限', {}, { mode: 'id' })
  const lines = text.split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[1], '旧会话：sess-old')
  assert.ok(!text.includes('当前目标'))
  assert.ok(!text.includes('yyyy'))
})

// ---------- 尾条渲染：最后 8 段、标签、套娃排掉 ----------

test('renderHandoffTail：只留最后 8 段，并带用户 / 助手 / 工具标签', () => {
  const events = []
  for (let i = 0; i < 10; i += 1) {
    events.push(user(`问 ${i}`))
    events.push(assistant(`答 ${i}`))
    events.push(call('pwsh', { command: `cmd ${i}` }))
  }
  const text = renderHandoffTail(events, { id: 'sess-old', workspace: { title: 'demo' }, steps: 41, limit: 40 })
  assert.ok(text.startsWith('# 会话交接尾条 · sess-old'))
  assert.ok(text.includes('只留了最后 8 段'))
  assert.ok(!text.includes('问 7'), '更早的段落被裁掉')
  assert.ok(text.includes('问 8'), '最后 8 段从这里开始')
  assert.ok(text.includes('[工具 pwsh]'))
  assert.ok(text.includes('command=cmd '), '工具调用要带一句参数摘要，不能只剩标签')
  assert.ok(text.includes('[助手]'))
  assert.ok(text.includes('[用户]'))
})

test('renderHandoffTail：上一轮的交接摘要不套娃，空文本跳过', () => {
  const text = renderHandoffTail(
    [user('真指令'), user('【会话交接 · 自动】\n工作区：demo'), assistant('   '), assistant('最后一句')],
    { id: 's' },
  )
  assert.ok(text.includes('真指令'))
  assert.ok(!text.includes('工作区：demo'))
  assert.ok(text.includes('最后一句'))
  assert.ok(text.includes('只留了最后 2 段'))
})

test('renderHandoffTail：单段超长会截断，且没有可渲染内容时不炸', () => {
  const long = renderHandoffTail([assistant('长'.repeat(500))], { id: 's' })
  assert.ok(long.includes('…（后略）'))
  const empty = renderHandoffTail(undefined, undefined)
  assert.ok(empty.includes('（旧会话没有可渲染的文本）'))
})
