import test from 'node:test'
import assert from 'node:assert/strict'
import { userTexts, summaryText, touchedFiles, ranCommands, pendingLines, tailLine } from '../lib/index.js'

const user = (text, kind = 'user') => ({
  type: 'user/message',
  data: { message: { role: 'user', content: [{ type: 'text', text }], source: kind === null ? undefined : { kind } } },
})
const assistant = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'assistant' } } },
})
const call = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })

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

test('summaryText：不再照贴上一轮正文，改成结构化状态', () => {
  const body = [
    '## 结论',
    '第一段：结论先放这里。',
    '',
    '未完成：release 还没跑',
    '要不要我按 D 方案动手改？',
    '',
    '第二段：' + '细'.repeat(300),
  ].join('\n')
  const session = { id: 'sess-old', ownEvents: () => [user('帮我看下 build 为什么挂'), assistant(body), user('再补一版')] }
  const text = summaryText(session, { title: 'demo' }, 41, 40, '越限（软上限）', {
    archiveOnRotate: false,
    deferArchiveMinutes: 5,
  })
  assert.ok(text.startsWith('【会话交接 · 自动】'))
  assert.ok(text.includes('上一会话未归档，仍在会话列表里'))
  assert.ok(text.includes('再补一版'))
  assert.ok(text.includes('未完成：release 还没跑'))
  assert.ok(text.includes('要不要我按 D 方案动手改？'))
  assert.ok(!text.includes('第二段'), '上一轮正文细节不该再照贴')
  assert.ok(!text.includes('>>>'))
  assert.ok(text.split('\n').length <= 14, '头部行数必须受控')
})

test('touchedFiles：只认写入类工具，去重保序', () => {
  const events = [
    call('read', { file_path: 'C:/a.md' }),
    call('edit', { file_path: 'C:/b.js' }),
    call('write', { file_path: 'C:/c.js' }),
    call('edit', { file_path: 'C:/b.js' }),
  ]
  assert.deepEqual(touchedFiles(events), ['C:/b.js', 'C:/c.js'])
})

test('touchedFiles：没有写入类工具时退回任何带路径的调用；arguments 是对象也行', () => {
  assert.deepEqual(touchedFiles([call('read', { file_path: 'C:/a.md' })]), ['C:/a.md'])
  assert.deepEqual(touchedFiles([{ type: 'tool/call', data: { name: 'pwsh', arguments: { command: 'ls' } } }]), [])
  assert.deepEqual(touchedFiles([{ type: 'tool/call', data: { name: 'edit', arguments: 'not json' } }]), [])
})

test('ranCommands：抽执行类工具的命令，取最后两条', () => {
  const events = [
    call('pwsh', { command: 'npm test' }),
    call('bash', { command: 'git status' }),
    call('read', { file_path: 'x' }),
  ]
  assert.deepEqual(ranCommands(events), ['npm test', 'git status'])
})

test('pendingLines：按段落收，「要你拍板的三处」三条一条都不能漏', () => {
  const reply = [
    '**拉片看出来、要你拍板的三处**',
    '1. S1 的 3.1–3.55s 把对话背景压到 13%，可以让气泡继续往上滚。',
    '2. S5 到 S6 之间白底淡出接黑底淡入，要不要做成硬切。',
    '3. 音轨整条是空的，要配乐得另外要素材。',
    '',
    '**还没动的两件事**：`C:\\dsh-demo-home\\.credentials.yaml` 是主实例复制来的；演示实例（3399）、Studio（3210）、headless Chrome（9222）还开着。',
  ].join('\n')
  const [line] = pendingLines(reply)
  assert.ok(line.includes('拍板的三处：1. S1'), line)
  assert.ok(line.includes('2. S5 到 S6'), line)
  assert.ok(line.includes('3. 音轨整条是空的'), line)
  assert.ok(line.includes('还没动的两件事：'), line)
  assert.ok(!line.includes('**'), '粗体标记要剥干净')
  assert.ok(!line.includes('**：'), line)
})

test('pendingLines：超长条目截在句号/分号上，不切半句', () => {
  const long = `${'甲'.repeat(200)}。${'乙'.repeat(300)}`
  const [line] = pendingLines(`还没做完：${long}`)
  assert.ok(line.endsWith('…'), line)
  assert.ok(line.includes('。'), '应退到句号边界再加省略号')
  assert.ok(!/乙+…$/.test(line), '不该切进第二句中间')
})

test('pendingLines：引号里的信号词是回顾，不算待办；单句照收', () => {
  assert.deepEqual(pendingLines('`NOTES.md` 的「还没解决」那节已经按现状改写完毕。'), [])
  assert.deepEqual(pendingLines('要不要我提交？'), ['要不要我提交？'])
})

test('tailLine：兜底取最后一段的最后一句', () => {
  assert.equal(tailLine('第一段。\n\n最后一句在这里。后面还有。'), '最后一句在这里。')
  assert.equal(tailLine(''), '')
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

test('summaryText：没有助手回复时三行状态写占位，不崩', () => {
  const session = { id: 's', ownEvents: () => [user('就一句话')] }
  const text = summaryText(session, { title: 'demo' }, 10, 40, null, { archiveOnRotate: true, deferArchiveMinutes: 0 })
  assert.ok(text.includes('上一会话已归档'))
  assert.ok(text.includes('最近改动：（无记录）'))
  assert.ok(text.includes('跑过什么：（无记录）'))
  assert.ok(text.includes('未完成：（未记录）'))
})

