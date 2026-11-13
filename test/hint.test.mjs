import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- 集成：真正走一遍 apply()，看标题编号与预算段落有没有接上宿主 ----------

/**
 * 起一份插件实例：假 ctx 里挂一个 agent，工作区有 sessionIds，标题由 projection 给。
 * 返回 emit（推 session/event）、renames（收到的 rename 请求）、sectionText（当前预算段落文本）。
 */
async function boot({ sessionIds = ['s1', 's2'], title = '修插件', steps = 0, maxSteps = 60 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-hint-'))
  const dir = path.join(home, 'session-rotate')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    defaultMaxSteps: maxSteps,
    workspaces: [{ name: 'work area', maxSteps }],
  }, null, 2))
  process.env.DSH_HOME = home

  const mod = await import(`../lib/index.js?case=${Date.now()}-${Math.random()}`)

  const session = { id: 's1', header: { cwd: 'C:\\demo' } }
  const workspace = { id: 'ws1', title: 'work area', sessionIds }
  const renames = []
  const handlers = new Map()
  const sections = []
  const agent = {
    session,
    ctx: {
      inject: (names, callback) => {
        assert.deepEqual(names, ['systemPrompt'])
        callback({ systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 100 } })
        return { dispose() {} }
      },
    },
  }

  const ctx = {
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    waterfall: async () => [],
    workspaceRegistry: { list: () => [workspace], archiveSession: async () => {} },
    sessionController: {
      prompt: async () => {},
      commands: { create: async () => ({ sessionId: 'new-1' }), rename: async (request) => renames.push(request) },
    },
    sessionProjections: {
      stateOf: (_session, key) => (key === 'title' ? title : key === 'sessionStats' ? { steps } : undefined),
    },
    webServer: { register: () => () => {} },
    agents: { list: () => [agent], get: () => agent },
    get: () => undefined,
  }

  mod.default.apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 30))

  const emit = async (type) => {
    for (const fn of handlers.get('session/event') ?? []) fn(session, { type })
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const log = () => fs.readFileSync(path.join(dir, 'debug.log'), 'utf8')
  const budget = () => {
    const section = sections.find((s) => s.name === 'session-rotate:budget')
    return section ? section.text() : undefined
  }
  return { emit, renames, sections, budget, log, home }
}

test('同工作区两个会话：turn/start 时标题加 [#N]', async () => {
  const run = await boot({ sessionIds: ['s1', 's2'], title: '修插件' })
  await run.emit('turn/start')
  assert.deepEqual(run.renames, [{ sessionId: 's1', title: '[#1] 修插件' }])
  assert.match(run.log(), /会话改名：s1 → \[#1\] 修插件/)
})

test('工作区只剩它一个：把编号剥掉', async () => {
  const run = await boot({ sessionIds: ['s1'], title: '[#3] 修插件' })
  await run.emit('turn/start')
  assert.deepEqual(run.renames, [{ sessionId: 's1', title: '修插件' }])
})

test('标题还没生成（空）：不动它，也不自己编', async () => {
  const run = await boot({ sessionIds: ['s1', 's2'], title: '' })
  await run.emit('turn/start')
  assert.deepEqual(run.renames, [])
})

test('预算段落已挂到 agent 作用域：不到软线时是空串', async () => {
  const run = await boot({ steps: 10, maxSteps: 60 })
  assert.ok(run.sections.some((s) => s.name === 'session-rotate:budget'))
  assert.equal(run.budget(), '')
  assert.ok(Number.isFinite(run.sections[0].order), 'order 必须是有限数字，否则宿主直接抛')
})

test('预算段落：接近上限时带上真实步数并要求建议新开', async () => {
  const run = await boot({ steps: 50, maxSteps: 60 })
  const text = run.budget()
  assert.match(text, /50\/60/)
  assert.match(text, /新开一个会话/)
  assert.match(run.log(), /预算提醒：s1 50\/60 步（near）/)
})

test('工作区不在名单里：turn/end 要留一行日志，同一份名单只吵一次', async () => {
  const run = await boot({ steps: 99, maxSteps: 60 })
  const cfgPath = path.join(run.home, 'session-rotate', 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ defaultMaxSteps: 60, workspaces: [{ name: '休闲区', maxSteps: 999 }] }, null, 2))
  await run.emit('turn/end')
  await run.emit('turn/end')
  const hits = run.log().match(/不在名单里/g) ?? []
  assert.equal(hits.length, 1, '不能每轮刷屏，但绝不能一次都不打（237 步那次就是静默跳过）')
  assert.match(run.log(), /工作区「work area」不在名单里（当前名单：休闲区）/)
})

test('预算段落：工作区不在名单里就不吭声（也不崩）', async () => {
  const run = await boot({ steps: 99, maxSteps: 60 })
  // 把名单改空：limit 变 undefined
  const cfgPath = path.join(run.home, 'session-rotate', 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ defaultMaxSteps: 60, workspaces: [] }, null, 2))
  assert.equal(run.budget(), '')
})
