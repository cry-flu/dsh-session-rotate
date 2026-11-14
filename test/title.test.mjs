import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseTitle,
  numberedTitle,
  extractSessionName,
  deriveSessionName,
  junkName,
} from '../lib/index.js'

// ---------- 标题拆解与幂等：层层堆叠的 接续/收尾/@时间 只能留一层 ----------

test('parseTitle 把前缀、标签、时间戳全剥出来', () => {
  assert.deepEqual(parseTitle('[#3] 收尾 · 修标题堆叠 @ 13:59'), {
    index: 3,
    tag: '收尾',
    stamp: '13:59',
    base: '修标题堆叠',
  })
})

test('parseTitle 循环剥离五层堆叠，只留最新的标签与时间戳', () => {
  const raw = '[#1] 收尾 · 接续 · 接续 · 接续 · 接续 · Fix promo video layout @ 02:38 @ 13:59'
  const parsed = parseTitle(raw)
  assert.equal(parsed.base, 'Fix promo video layout')
  assert.equal(parsed.index, 1)
  // 最外层的「收尾」是最新一次写下的，保留它
  assert.equal(parsed.tag, '收尾')
  // 最先剥到的是尾部那个时间戳，也就是最新的一个
  assert.equal(parsed.stamp, '13:59')
})

test('numberedTitle 幂等：同样的标题连算三次不变', () => {
  const once = numberedTitle('修标题堆叠', 2, { tag: '接续', stamp: '10:05' })
  const twice = numberedTitle(once, 2, { tag: '接续', stamp: '10:05' })
  const thrice = numberedTitle(twice, 2)
  assert.equal(once, '[#2] 接续 · 修标题堆叠 @ 10:05')
  assert.equal(twice, once)
  assert.equal(thrice, once)
})

test('ensureNumbering 路径不会抹掉换新时写下的标签与时间', () => {
  // 只改序号（不带 opts）：标签、时间沿用标题里已有的
  assert.equal(numberedTitle('[#4] 收尾 · 修标题堆叠 @ 11:20', 2), '[#2] 收尾 · 修标题堆叠 @ 11:20')
  // 去掉序号（工作区只剩一个会话）
  assert.equal(numberedTitle('[#2] 接续 · 修标题堆叠 @ 11:20', 0), '接续 · 修标题堆叠 @ 11:20')
})

test('真标题里的中点不会被当成接续/收尾标签', () => {
  assert.equal(numberedTitle('A · B 的对比实验', 1).replace('[#1] ', ''), 'A · B 的对比实验')
  assert.equal(parseTitle('A · B 的对比实验').tag, '')
})

test('标题本身就是时间样式时不把 base 吃空', () => {
  assert.equal(parseTitle('@ 02:38').base, '@ 02:38')
  assert.equal(parseTitle('@ 02:38').stamp, '')
})

test('半截图的时间戳留在 base 里，不会丢字', () => {
  const parsed = parseTitle('[#2] 接续 · 跑长任务 @ 02')
  assert.equal(parsed.base, '跑长任务 @ 02')
  assert.equal(parsed.stamp, '')
})

test('先截 base 再拼装饰：时间戳不会被切一半', () => {
  const long = '修'.repeat(80)
  const out = numberedTitle(long, 2, { tag: '接续', stamp: '13:59' })
  assert.ok(out.endsWith(' @ 13:59'))
  assert.equal(parseTitle(out).base.length, 40)
})

test('坏输入不炸', () => {
  assert.equal(numberedTitle('', 0), '')
  assert.equal(numberedTitle(null, NaN), '')
  assert.equal(parseTitle(undefined).base, '')
})

// ---------- 会话名：模型末轮自述 → 当前目标首句 → 末个改动文件名 ----------

function assistant(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function user(text) {
  return { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } }
}

function toolCall(name, args) {
  return { type: 'tool/call', data: { name, arguments: JSON.stringify(args) } }
}

function sessionOf(events) {
  return { id: 's-1', ownEvents: () => events }
}

test('extractSessionName 取最后一个标记，去掉引号与尾标点', () => {
  const text = ['先做 A。', 'SESSION_TITLE: 旧名字', '中间', 'SESSION_TITLE：「修标题堆叠。」'].join('\n')
  assert.equal(extractSessionName(text), '修标题堆叠')
})

test('extractSessionName 支持全角冒号，抽不到返回空串', () => {
  assert.equal(extractSessionName('SESSION_TITLE：接入语音合成'), '接入语音合成')
  assert.equal(extractSessionName('没有标记'), '')
  assert.equal(extractSessionName(''), '')
})

test('extractSessionName 超长截到侧栏宽度（含省略号共 20 字）', () => {
  const name = extractSessionName(`SESSION_TITLE: ${'很'.repeat(40)}`)
  assert.equal(name.length, 20)
  assert.ok(name.endsWith('…'))
})

test('deriveSessionName 优先用模型末轮给的名字', () => {
  const s = sessionOf([user('把这堆活干完'), assistant('做完了\nSESSION_TITLE: 修标题堆叠')])
  assert.equal(deriveSessionName(s), '修标题堆叠')
})

test('deriveSessionName 抽不到标记时退到当前目标首句', () => {
  const s = sessionOf([user('把标题堆叠的问题修掉。另外看看文档'), assistant('好')])
  assert.equal(deriveSessionName(s), '把标题堆叠的问题修掉')
})

test('deriveSessionName 连目标都没有时退到末个改动文件名', () => {
  const s = sessionOf([toolCall('write', { file_path: 'D:\\repo\\lib\\index.js' }), assistant('好了')])
  assert.equal(deriveSessionName(s), 'index.js')
})

test('deriveSessionName 什么都没有就返回空串（交给现标题兜底）', () => {
  assert.equal(deriveSessionName(sessionOf([])), '')
  assert.equal(deriveSessionName({}), '')
  assert.equal(deriveSessionName({ ownEvents: () => { throw new Error('boom') } }), '')
})

// ---------- 垃圾会话名：只回「好」「1」「确认」时不能再当标题 ----------

test('junkName 拦住应答词、纯数字、纯符号', () => {
  for (const bad of ['好', '好的', '嗯', '可以', '确认', '继续', '收到', '1', '2.', '...', '---', 'ok', 'OK']) {
    assert.equal(junkName(bad), true, `应判为垃圾名: ${bad}`)
  }
})

test('junkName 放过有信息量的名字', () => {
  for (const good of ['修标题堆叠', '改 bug', 'index.js', '会话名抽取', '整理 1.6.0 文档']) {
    assert.equal(junkName(good), false, `不该判为垃圾名: ${good}`)
  }
})

test('deriveSessionName 忽略模型给的垃圾名，退到用户消息', () => {
  const s = sessionOf([user('把会话名抽垃圾的问题修掉'), assistant('好了\nSESSION_TITLE: 好')])
  assert.equal(deriveSessionName(s), '把会话名抽垃圾的问题修掉')
})

test('deriveSessionName 末条用户消息只是应答词时，往前找第一条有内容的', () => {
  const s = sessionOf([user('把会话名抽垃圾的问题修掉。另外看看测试'), assistant('做完'), user('好')])
  assert.equal(deriveSessionName(s), '把会话名抽垃圾的问题修掉')
})

test('deriveSessionName 全程只有应答词时退到改动文件名', () => {
  const s = sessionOf([user('好'), toolCall('edit', { file_path: 'D:\\repo\\lib\\title.js' }), assistant('确认')])
  assert.equal(deriveSessionName(s), 'title.js')
})
