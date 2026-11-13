import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- 真首轮闸：没有增量历史时不换，只记一条日志 ----------
// 走真 apply() + 假 ctx，从 turn/end 事件进 rotateIfDue。

const WS = { id: 'ws-1', title: 'demo', path: 'C:\\demo', sessionIds: ['s-1'] }

async function boot({ steps, limit = 40, minSteps = 10, dryRun = false }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-first-'))
  const dir = path.join(home, 'session-rotate')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        defaultMaxSteps: limit,
        workspaces: [{ name: 'demo', maxSteps: null }],
        minSteps,
        cooldownMinutes: 0,
        maxRotations: 20,
        dryRun,
        archiveOnRotate: true,
        autoSwitch: true,
        switchOnArchive: false,
        deferArchiveMinutes: 0,
      },
      null,
      2,
    ),
  )
  process.env.DSH_HOME = home

  const mod = await import(`../lib/index.js?case=${Date.now()}-${Math.random()}`)
  const handlers = {}
  const created = []
  const ctx = {
    on: (name, fn) => {
      handlers[name] = fn
    },
    waterfall: async () => [],
    workspaceRegistry: { list: () => [WS], archiveSession: async () => {} },
    sessionController: {
      prompt: async () => {},
      commands: {
        create: async () => {
          created.push(1)
          return { sessionId: 's-2' }
        },
        rename: async () => {},
      },
    },
    sessionProjections: { stateOf: (_s, key) => (key === 'sessionStats' ? { steps } : undefined) },
    webServer: { register: () => () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: () => undefined,
  }
  mod.default.apply(ctx, {})

  const session = { id: 's-1', header: { cwd: 'C:\\demo' }, ownEvents: () => [] }
  handlers['session/event'](session, { type: 'turn/end' })
  await new Promise((resolve) => setTimeout(resolve, 80))

  const logPath = path.join(dir, 'debug.log')
  const statePath = path.join(dir, 'state.json')
  return {
    created,
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
    state: fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {},
  }
}

test('首轮无基线且退化成必换（steps >= limit/2）：不换，只记一条「首轮无基线」', async () => {
  const run = await boot({ steps: 25, limit: 40 })
  assert.equal(run.created.length, 0, '首轮不该建新会话')
  assert.match(run.log, /首轮无基线，不换，等下一轮/)
  assert.doesNotMatch(run.log, /换新：/, '不该真的换')
  assert.deepEqual(run.state.lastRotateAt ?? {}, {}, '没换就不该写冷却时间戳')
})

test('首轮无基线但 steps 远小于 limit/2：不产生「首轮无基线」，走正常放行', async () => {
  const run = await boot({ steps: 5, limit: 40, minSteps: 0 })
  assert.equal(run.created.length, 0)
  assert.doesNotMatch(run.log, /首轮无基线/, '没有换新意图的轮次不许刷这条日志')
  assert.match(run.log, /放行/)
})

test('steps < minSteps：归因给 minSteps，不说「首轮无基线」', async () => {
  const run = await boot({ steps: 22, limit: 40, minSteps: 25 })
  assert.equal(run.created.length, 0)
  assert.match(run.log, /未达最小步数/)
  assert.doesNotMatch(run.log, /首轮无基线/)
})

test('steps 不到 minSteps 且本来就换不着：只报预判值，也不说「首轮无基线」', async () => {
  const run = await boot({ steps: 5, limit: 40, minSteps: 10 })
  assert.equal(run.created.length, 0)
  assert.match(run.log, /放行（预判值 10）/)
  assert.doesNotMatch(run.log, /首轮无基线/)
})

test('dry-run：同一分支也记一条，写明 dry-run 同样不换', async () => {
  const run = await boot({ steps: 25, limit: 40, dryRun: true })
  assert.equal(run.created.length, 0)
  assert.match(run.log, /\[dry-run\]/)
  assert.match(run.log, /首轮无基线，不换：dry-run 同样不换/)
})
