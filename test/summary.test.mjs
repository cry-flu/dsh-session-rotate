import test from 'node:test'
import assert from 'node:assert/strict'
import { userTexts } from '../lib/index.js'

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
