import test from 'node:test'
import assert from 'node:assert/strict'
import { userTexts, summaryText } from '../lib/index.js'

const user = (text, kind = 'user') => ({
  type: 'user/message',
  data: { message: { role: 'user', content: [{ type: 'text', text }], source: kind === null ? undefined : { kind } } },
})
const assistant = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'assistant' } } },
})

test('userTexts：保留真人用户消息，按时间顺序', () => {
  const out = userTexts([user('第一句'), assistant('回复'), user('第二句')])
  assert.deepEqual(out, ['第一句', '第二句'])
})

test('userTexts：上一轮投递的交接摘要不再抄进下一份', () => {
  const handoff = '【会话交接 · 自动】\n工作区：my-workspace\n当前目标：上文那段'
  const out = userTexts([user('真指令'), user(handoff), user('新指令')])
  assert.deepEqual(out, ['真指令', '新指令'])
})

test('userTexts：非 user 来源与非文本内容都跳过', () => {
  const out = userTexts([user('保留'), user('插件发的', 'plugin'), user('   '), { type: 'user/message' }])
  assert.deepEqual(out, ['保留'])
})

test('userTexts：空输入不炸', () => {
  assert.deepEqual(userTexts(undefined), [])
  assert.deepEqual(userTexts([]), [])
})

test('summaryText：上一轮正文整段照贴，换新后不必回旧会话翻', () => {
  const body = '第一段：结论先放这里。\n\n第二段：细节和命令都在这里，' + '细'.repeat(300)
  const session = { id: 'sess-old', ownEvents: () => [user('帮我看下 build 为什么挂'), assistant(body), user('再补一版')] }
  const text = summaryText(session, { title: 'demo' }, 41, 40, '越限（软上限）', {
    archiveOnRotate: false,
    deferArchiveMinutes: 5,
  })
  assert.ok(text.startsWith('【会话交接 · 自动】'))
  assert.ok(text.includes('上一会话未归档，仍在会话列表里'))
  assert.ok(text.includes('第一段：结论先放这里。'))
  assert.ok(text.includes('第二段：细节和命令都在这里'))
  assert.ok(text.includes('再补一版'))
  assert.ok(text.trimEnd().endsWith('>>>'))
})

test('summaryText：延迟归档时写清「先留 N 分钟」；0 分钟才算已归档', () => {
  const session = { id: 'sess-old', ownEvents: () => [assistant('好')] }
  const deferred = summaryText(session, { title: 'demo' }, 41, 40, null, { archiveOnRotate: true, deferArchiveMinutes: 5 })
  assert.ok(deferred.includes('上一会话先留在列表里 5 分钟'))
  const immediate = summaryText(session, { title: 'demo' }, 41, 40, null, { archiveOnRotate: true, deferArchiveMinutes: 0 })
  assert.ok(immediate.includes('上一会话已归档'))
})

test('summaryText：不跳转时不说「已归档」（旧会话其实还在）', () => {
  const session = { id: 'sess-old', ownEvents: () => [assistant('好')] }
  const text = summaryText(session, { title: 'demo' }, 41, 40, null, {
    archiveOnRotate: true,
    deferArchiveMinutes: 0,
    autoSwitch: false,
  })
  assert.ok(text.includes('上一会话未归档'))
  assert.ok(!text.includes('上一会话已归档'))
})

test('summaryText：没有助手回复时有占位，不崩', () => {
  const session = { id: 's', ownEvents: () => [user('就一句话')] }
  const text = summaryText(session, { title: 'demo' }, 10, 40, null, { archiveOnRotate: true, deferArchiveMinutes: 0 })
  assert.ok(text.includes('上一会话已归档'))
  assert.ok(text.includes('（上一轮没有文本回复）'))
})

