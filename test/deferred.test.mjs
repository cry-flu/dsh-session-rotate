import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deferredStep } from '../lib/index.js'

// ---------- 纯函数：到点归档这一步怎么走 ----------

test('deferredStep：没有活动就归档', () => {
  assert.equal(deferredStep([], 0), 'archive')
  assert.equal(deferredStep(undefined, 0), 'archive')
  assert.equal(deferredStep(null, 0), 'archive')
  assert.equal(deferredStep('not-an-array', 0), 'archive')
})

test('deferredStep：还有活在跑就顺延', () => {
  assert.equal(deferredStep([{ kind: 'turn' }], 0), 'defer')
  assert.equal(deferredStep([{ kind: 'job' }, { kind: 'subagent' }], 0), 'defer')
  assert.equal(deferredStep([{ kind: 'turn' }], 9), 'defer')
})

test('deferredStep：顺延次数用完就放弃，不会回落到强杀', () => {
  assert.equal(deferredStep([{ kind: 'turn' }], 10), 'giveup')
  assert.equal(deferredStep([{ kind: 'turn' }], 11), 'giveup')
  assert.equal(deferredStep([{ kind: 'turn' }], 3, 3), 'giveup')
  assert.equal(deferredStep([{ kind: 'turn' }], 2, 3), 'defer')
  // 次数用完但会话已经闲下来：照样归档，不白丢一条待办
  assert.equal(deferredStep([], 10), 'archive')
})

// ---------- 集成：真正走一遍 apply()，看它有没有调 archiveSession ----------

/** 用临时 DSH_HOME 起一份插件实例：state.json 里预置一条已到点的待归档 */
async function boot({ activity, entry, own = ['old-1'] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-test-'))
  const dir = path.join(home, 'session-rotate')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    ownSessions: own,
    deferredArchives: { 'old-1': entry ?? { toId: 'new-1', at: Date.now(), deadline: Date.now() - 1000 } },
  }, null, 2))
  process.env.DSH_HOME = home

  const mod = await import(`../lib/index.js?case=${Date.now()}-${Math.random()}`)
  const calls = []
  const probed = []
  const ctx = {
    on: () => {},
    waterfall: async (name) => {
      probed.push(name)
      return activity
    },
    workspaceRegistry: {
      list: () => [],
      archiveSession: async (id, options) => {
        calls.push({ id, options })
      },
    },
    sessionController: { prompt: async () => {}, commands: { create: async () => ({ id: 'new-1' }) } },
    sessionProjections: { stateOf: () => ({ steps: 0 }) },
    webServer: { register: () => () => {} },
    agents: { get: () => undefined },
    get: () => undefined,
  }
  mod.default.apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 80))

  const statePath = path.join(dir, 'state.json')
  const logPath = path.join(dir, 'debug.log')
  return {
    calls,
    probed,
    saved: JSON.parse(fs.readFileSync(statePath, 'utf8')),
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
    home,
  }
}


test('到点还有活在跑：不调 archiveSession，条目留着，retries+1，重挂定时器', async () => {
  const run = await boot({ activity: [{ kind: 'turn' }] })
  assert.equal(run.probed[0], 'workspace/session-activity')
  assert.equal(run.calls.length, 0)
  const entry = run.saved.deferredArchives['old-1']
  assert.ok(entry, '待归档条目必须还在（失败也要留着下次再试）')
  assert.equal(entry.retries, 1)
  assert.ok(entry.deadline > Date.now() + 30_000, '必须重挂到一个 RETRY_MS 之后')
  assert.match(run.log, /顺延 60 秒/)
})

test('再查时已经空闲：归档成功，且不带 stopActivity', async () => {
  const run = await boot({ activity: [] })
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].id, 'old-1')
  assert.equal(run.calls[0].options, undefined, '绝不能传 stopActivity —— 那会掐断正在跑的轮')
  assert.deepEqual(run.saved.deferredArchives, {})
  assert.match(run.log, /已到点归档：old-1/)
})

test('归档被宿主 WorkspaceActiveSessionError 挡下：继续顺延，不掐断', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-test-'))
  const dir = path.join(home, 'session-rotate')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    ownSessions: ['old-1'],
    deferredArchives: { 'old-1': { toId: 'new-1', at: Date.now(), deadline: Date.now() - 1000 } },
  }, null, 2))
  process.env.DSH_HOME = home

  const mod = await import(`../lib/index.js?case=${Date.now()}-${Math.random()}`)
  const calls = []
  const ctx = {
    on: () => {},
    waterfall: async () => [],
    workspaceRegistry: {
      list: () => [],
      archiveSession: async (id, options) => {
        calls.push({ id, options })
        const error = new Error('会话还有活在跑')
        error.name = 'WorkspaceActiveSessionError'
        throw error
      },
    },
    sessionController: { prompt: async () => {}, commands: { create: async () => ({ id: 'new-1' }) } },
    sessionProjections: { stateOf: () => ({ steps: 0 }) },
    webServer: { register: () => () => {} },
    agents: { get: () => undefined },
    get: () => undefined,
  }
  mod.default.apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 80))

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  const log = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options, undefined)
  assert.equal(saved.deferredArchives['old-1']?.retries, 1, '被挡下要顺延，条目不能丢')
  assert.match(log, /归档被宿主挡下/)
})

test('顺延次数用尽：放弃归档，会话原样留着', async () => {
  const run = await boot({
    activity: [{ kind: 'schedule' }],
    entry: { toId: 'new-1', at: Date.now(), deadline: Date.now() - 1000, retries: 10 },
  })
  assert.equal(run.calls.length, 0)
  assert.deepEqual(run.saved.deferredArchives, {}, '放弃后待办要摘掉，不能无限挂着')
  assert.match(run.log, /放弃到点归档/)
})
