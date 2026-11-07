/**
 * dsh-session-rotate —— 会话步数到上限时，自动开新会话 + 交接摘要，并归档旧会话
 *
 * 行为（全部发生在「一轮结束」之后，绝不打断进行中的轮）：
 *   1. turn/end 时读 sessionStats.steps，按工作区匹配到的 maxSteps 判定；
 *   2. 判定两条：越限（steps >= maxSteps）或预判（steps + 近 3 轮增量均值 + 1 >= maxSteps），见 lib/decide.js；
 *   3. 三道闸依次挡：最小步数 minSteps → 冷却 cooldownMinutes → 连续换新上限 maxRotations，
 *      最后按 dryRun 决定「只记日志」还是「真换」；
 *   4. 真换：建新会话（同工作区）→ sessionController.prompt 投递本地拼装的交接摘要 → 归档旧会话；
 *   5. 摘要由本地模板拼，≤16 行，不调模型；同时写继承表 session-rotate-heirs.json，
 *      供其它「按固定 sessionId 投递」的插件（如 dsh-bili-whale）接力到新会话。
 *
 * 配置（cordis patch 的 config；设置面板写的 session-rotate/config.json 优先级更高、改完即生效）：
 *   defaultMaxSteps: 40
 *   workspaces:
 *     - name: my-workspace      # 与侧边栏显示名完全一致（含空格、大小写）
 *       maxSteps: null       # null / 省略 / 0 / 空串 = 跟随 defaultMaxSteps
 *   minSteps / cooldownMinutes / maxRotations / dryRun 见 README「保护闸与试运行」。
 *   workspaces 为空 = 全部不生效（默认关闭）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { decideRotate } from './decide.js'

/** 用来确认「内存里跑的是哪一版」，别只靠路由 401/404 猜 */
const SELF_FILE = fileURLToPath(import.meta.url)
const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(SELF_FILE), '..', 'package.json'), 'utf8'))
    return String(pkg.version ?? '?')
  } catch {
    return '?'
  }
})()
const SELF_MTIME = (() => {
  try {
    return fs.statSync(SELF_FILE).mtime.toISOString()
  } catch {
    return '?'
  }
})()

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HEIRS_FILE = path.join(HOME, 'session-rotate-heirs.json')
// 设置面板写的运行时配置；存在就覆盖 cordis patch 里的值，改完立即生效
const CONFIG_FILE = path.join(HOME, 'session-rotate', 'config.json')
const LINE_CUT = 200
const LIST_CUT = 120
/** 交接摘要的首行标记：投递时它是 user 消息，回读时要靠它排掉自己 */
const HANDOFF_MARK = '【会话交接 · 自动】'

const LOG_FILE = path.join(HOME, 'session-rotate', 'debug.log')
/** 日志超过这个大小就整份转存成 debug.log.1，避免无限增长 */
const LOG_MAX_BYTES = 1_000_000
/** 冷却 / 连续换新 / 暂停 / 跨会话增量历史，落盘防止「重启即绕过防护」 */
const STATE_FILE = path.join(HOME, 'session-rotate', 'state.json')

/** 桌面版的 console 看不到，所以同时落一份文件，方便排查 */
function log(...args) {
  console.log('[session-rotate]', ...args)
  try {
    const line = new Date().toISOString() + ' ' +
      args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * 先写同目录临时文件再 rename：写到一半崩掉也不会留下半截 JSON。
 * Windows 上 rename 会覆盖已存在的目标文件；临时文件名带 pid，避免多实例互踩。
 */
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清不掉就算了，下次覆盖 */
    }
    throw error
  }
}

/** 空值（null / undefined / '' / 0 / 负数）= 跟随默认，不是"不生效" */
function isBlank(value) {
  if (value === null || value === undefined || value === '') return true
  const n = Number(value)
  return !Number.isFinite(n) || n <= 0
}

/** 三道保护闸的默认值（minSteps 允许 0 = 关掉这道闸，其它 <=0 回落到默认） */
function protectionsOf(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const minRaw = Number(c.minSteps)
  return {
    minSteps: Number.isFinite(minRaw) && minRaw >= 0 ? Math.floor(minRaw) : 10,
    cooldownMinutes: toPositiveInt(c.cooldownMinutes, 10),
    maxRotations: toPositiveInt(c.maxRotations, 3),
    dryRun: c.dryRun === true,
  }
}

/** 单个工作区可以覆盖保护闸：只认显式写了的键，缺省 = 跟随顶层 */
function workspaceOverrides(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const given = (value) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))
  const out = {}
  if (given(c.minSteps) && Number(c.minSteps) >= 0) out.minSteps = Math.floor(Number(c.minSteps))
  if (given(c.cooldownMinutes) && Number(c.cooldownMinutes) > 0) out.cooldownMinutes = Math.floor(Number(c.cooldownMinutes))
  if (given(c.maxRotations) && Number(c.maxRotations) > 0) out.maxRotations = Math.floor(Number(c.maxRotations))
  return out
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const def = toPositiveInt(c.defaultMaxSteps, 40)
  const map = new Map()
  const overrides = new Map()
  const list = Array.isArray(c.workspaces) ? c.workspaces : []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (name === '') continue
    map.set(name, isBlank(entry.maxSteps) ? def : toPositiveInt(entry.maxSteps, def))
    const ov = workspaceOverrides(entry)
    if (Object.keys(ov).length > 0) overrides.set(name, ov)
  }
  return { def, map, overrides, ...protectionsOf(c) }
}

/* ---------- 运行时配置：设置面板 ↔ config.json ---------- */

/** cordis patch 里声明的配置，config.json 不存在时回落到它 */
let patchConfig = null

/** 读 config.json：不存在返回 null，损坏则记日志后回落 */
function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    if (error?.code !== 'ENOENT') log('读 config.json 失败，回落到 patch 配置:', error?.message ?? error)
    return null
  }
}

/** 每次判定都现读：设置面板保存后立即生效，不用重启 */
function currentConfig() {
  const file = readConfigFile()
  return file
    ? { ...normalizeConfig(file), source: 'file' }
    : { ...normalizeConfig(patchConfig), source: 'patch' }
}

/** 面板提交的内容先过一遍，非法项直接丢弃；maxSteps 留空保持 null（= 跟随默认）,未提交的键沿用 prev */
function sanitizeConfig(raw, prev) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const old = prev && typeof prev === 'object' ? prev : {}
  const def = toPositiveInt(c.defaultMaxSteps, toPositiveInt(old.defaultMaxSteps, 40))
  const list = Array.isArray(c.workspaces) ? c.workspaces : []
  /** 已存配置里的工作区附加项：面板只提交 name/maxSteps，这些得原样带过去 */
  const oldExtras = new Map()
  for (const entry of Array.isArray(old.workspaces) ? old.workspaces : []) {
    if (!entry || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '') continue
    const ov = workspaceOverrides(entry)
    if (Object.keys(ov).length > 0) oldExtras.set(name, ov)
  }
  const seen = new Set()
  const workspaces = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    const row = { name, maxSteps: isBlank(entry.maxSteps) ? null : toPositiveInt(entry.maxSteps, null) }
    const ov = { ...(oldExtras.get(name) ?? {}), ...workspaceOverrides(entry) }
    if (ov.minSteps !== undefined) row.minSteps = ov.minSteps
    if (ov.cooldownMinutes !== undefined) row.cooldownMinutes = ov.cooldownMinutes
    if (ov.maxRotations !== undefined) row.maxRotations = ov.maxRotations
    workspaces.push(row)
  }
  /** 面板提交带了就用提交值，没带沿用文件里已有的，最后才回落默认 */
  const asCount = (value, fallback, min) => {
    const n = Number(value)
    const given = value !== undefined && value !== null && value !== '' && Number.isFinite(n) && n >= min
    return given ? Math.floor(n) : fallback
  }
  return {
    defaultMaxSteps: def,
    workspaces,
    minSteps: asCount(c.minSteps, asCount(old.minSteps, 10, 0), 0),
    cooldownMinutes: asCount(c.cooldownMinutes, asCount(old.cooldownMinutes, 10, 1), 1),
    maxRotations: asCount(c.maxRotations, asCount(old.maxRotations, 3, 1), 1),
    dryRun: c.dryRun === undefined ? old.dryRun === true : c.dryRun === true,
  }
}

/** 步数上限低于「最低步数」时这道闸永远不生效，值得提示 */
function configWarnings(cfg) {
  const out = []
  if (cfg.def < cfg.minSteps) {
    out.push(`默认上限 ${cfg.def} 步 < 最低步数 ${cfg.minSteps}：minSteps 闸对默认上限的工作区无效`)
  }
  for (const [name, limit] of cfg.map) {
    if (limit === cfg.def) continue // 跟随默认的，已被上面那条覆盖
    const ov = cfg.overrides?.get(name) ?? {}
    const min = ov.minSteps ?? cfg.minSteps
    if (limit < min) out.push(`工作区「${name}」上限 ${limit} 步 < 最低步数 ${min}：minSteps 闸对它无效`)
  }
  return out
}

/** debug.log 末尾若干行，给面板看 */
function logTail(count) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').trimEnd()
    return text === '' ? '' : text.split('\n').slice(-count).join('\n')
  } catch {
    return ''
  }
}

/** 单行化 + 截断：摘要里不允许出现换行，避免行数失控 */
function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat
}

/** 从事件里取纯文本（兼容 data.message / data.content 两种形状） */
function textOf(event) {
  const data = event?.data ?? {}
  const message = data.message ?? data
  const content = message?.content ?? data.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
  }
  return ''
}

function isFromUser(event) {
  const data = event?.data ?? {}
  const source = data.message?.source ?? data.source
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return true
  if (typeof source.kind !== 'string') return true
  return source.kind === 'user'
}

/** 摘要里要用的「用户说的话」，按时间顺序 —— 交接摘要自身也算 user 消息，要排掉 */
export function userTexts(events) {
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    if (!isFromUser(event)) continue
    const text = textOf(event)
    if (String(text).trim() === '') continue
    // 上一轮投递的交接摘要带 source.kind='user'：不排掉就会被当成用户指令
    // 再抄进下一份摘要（「当前目标」永远是交接文本），越换越发散
    if (String(text).trimStart().startsWith(HANDOFF_MARK)) continue
    out.push(text)
  }
  return out
}

export default {
  name: 'dsh-session-rotate',
  inject: ['sessionController', 'workspaceRegistry', 'sessionProjections', 'webServer', 'connection', 'agents'],
  apply(ctx, config) {
    patchConfig = config ?? ctx?.config ?? ctx?.options
    const cfg = currentConfig()
    const done = new Set()
    const state = { pending: null }
    // 投递通道：第一条走通的记下来，之后一直用它
    let deliveryChannel = null

    async function deliver(sessionId, text) {
      const content = [{ type: 'text', text }]
      const failures = []

      if (deliveryChannel === null || deliveryChannel === 'prompt') {
        try {
          await ctx.sessionController.prompt({ sessionId, content })
          deliveryChannel = 'prompt'
          return 'prompt'
        } catch (error) {
          failures.push(['prompt', String(error?.message ?? error)])
          deliveryChannel = null
        }
      }

      if (deliveryChannel === null || deliveryChannel === 'followup') {
        try {
          const agent = ctx.agents?.get?.(sessionId)
          if (!agent || typeof agent.followup !== 'function') throw new Error('agents.get 拿不到可投递的 agent')
          agent.followup({
            id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
            role: 'user',
            content,
            source: { kind: 'user' },
          })
          deliveryChannel = 'followup'
          return 'followup'
        } catch (error) {
          failures.push(['followup', String(error?.message ?? error)])
          deliveryChannel = null
        }
      }

      throw new Error(`所有投递通道都失败：${JSON.stringify(failures)}`)
    }

    // 热重载时新旧实例会同时在场：用代次号接管路由，旧实例的 dispose 不再误删新路由
    const ROUTE_KEY = Symbol.for('dsh-session-rotate.routes')
    const GEN_KEY = Symbol.for('dsh-session-rotate.gen')
    const myGen = (globalThis[GEN_KEY] ?? 0) + 1
    globalThis[GEN_KEY] = myGen
    for (const fn of globalThis[ROUTE_KEY] ?? []) {
      try {
        fn()
      } catch {
        /* 已被摘除 */
      }
    }
    globalThis[ROUTE_KEY] = []
    const routeDisposers = globalThis[ROUTE_KEY]
    ctx.on('dispose', () => {
      if (globalThis[GEN_KEY] !== myGen) return
      for (const fn of routeDisposers) {
        try {
          fn()
        } catch {
          /* 已摘除 */
        }
      }
    })
    const keepRoute = (disposeRoute) => {
      if (typeof disposeRoute === 'function') routeDisposers.push(disposeRoute)
    }

    log(`已加载 v${PLUGIN_VERSION}（lib/index.js mtime ${SELF_MTIME}）：默认上限 ${cfg.def} 步，生效工作区 ${cfg.map.size} 个`)

    // ---- 客户端轮询端点：告诉浏览器「跳到哪个新会话」 ----
    try {
      const disposeRoute = ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-rotate/state',
        handler: async (req, res) => {
          const conn = ctx.get?.('connection') ?? ctx.connection
          if (conn && typeof conn.requestRejection === 'function') {
            const code = conn.requestRejection(req)
            if (code !== undefined && code !== null && code !== false) {
              res.statusCode = typeof code === 'number' ? code : 403
              res.end()
              return
            }
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          const live = currentConfig()
          res.end(JSON.stringify({
            pending: state.pending,
            defaultMaxSteps: live.def,
            workspaces: [...live.map.entries()].map(([name, maxSteps]) => ({ name, maxSteps })),
          }))
        },
      })
      keepRoute(disposeRoute)
    } catch (error) {
      log('路由注册失败（客户端跳转将不可用）:', error?.message ?? error)
    }

    // ---- 自检端点（仅回环）：真跑一遍 建会话 → 发消息 → 归档 ----
    try {
      const disposeSelfTest = ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-rotate/selftest',
        handler: async (req, res) => {
          const ip = req.socket?.remoteAddress ?? ''
          const loop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          if (!loop) {
            res.statusCode = 403
            res.end(JSON.stringify({ ok: false, error: 'loopback only' }))
            return
          }
          const steps = []
          try {
            const wanted = [...currentConfig().map.keys()][0]
            const roster = ctx.workspaceRegistry.list() ?? []
            const ws = wanted === undefined ? roster[0] : roster.find((w) => w.title === wanted)
            if (!ws) throw new Error(`找不到可用工作区（配置名「${wanted}」，实际 ${roster.length} 个）`)
            steps.push(`工作区 ${ws.title} (${ws.id})`)
            const created = await ctx.sessionController.commands.create({ workspaceId: ws.id })
            const sid = created?.sessionId ?? created?.id ?? created?.session?.id
            if (!sid) throw new Error('create 未返回会话 id: ' + JSON.stringify(created))
            steps.push(`已建会话 ${sid}`)
            const channel = await deliver(sid, '【自检】这条消息由 dsh-session-rotate 发出，用来验证投递链路。')
            steps.push(`已发出首条消息（通道 ${channel}）`)
            await new Promise((resolve) => setTimeout(resolve, 800))
            try {
              const agent = ctx.agents.get(sid)
              const stats = ctx.sessionProjections.stateOf(agent.session, 'sessionStats')
              steps.push(`新会话 turns=${stats?.turns ?? '?'} steps=${stats?.steps ?? '?'}`)
            } catch (error) {
              steps.push(`读投影失败：${String(error?.message ?? error)}`)
            }
            await ctx.workspaceRegistry.archiveSession(sid, { stopActivity: true })
            steps.push('已归档该会话')
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true, sessionId: sid, steps }))
          } catch (error) {
            res.statusCode = 500
            res.end(JSON.stringify({
              ok: false,
              steps,
              error: String(error?.message ?? error),
              stack: String(error?.stack ?? '')
                .split('\n')
                .slice(0, 8)
                .map((line) => line.trim()),
            }))
          }
        },
      })
      keepRoute(disposeSelfTest)
    } catch (error) {
      log('自检路由注册失败:', error?.message ?? error)
    }

    // ---- 设置面板端点：读 / 写运行时配置 ----
    try {
      const guard = (req, res) => {
        const conn = ctx.get?.('connection') ?? ctx.connection
        if (conn && typeof conn.requestRejection === 'function') {
          const code = conn.requestRejection(req)
          if (code !== undefined && code !== null && code !== false) {
            res.statusCode = typeof code === 'number' ? code : 403
            res.end()
            return false
          }
        }
        return true
      }

      const readBody = (req) =>
        new Promise((resolve, reject) => {
          const chunks = []
          let size = 0
          req.on('data', (chunk) => {
            size += chunk.length
            if (size > 64 * 1024) {
              reject(new Error('请求体过大'))
              req.destroy()
              return
            }
            chunks.push(chunk)
          })
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          req.on('error', reject)
        })

      const rosterOf = () => {
        let list = []
        try {
          list = ctx.workspaceRegistry.list() ?? []
        } catch {
          list = []
        }
        return list.map((w) => ({ name: w.title ?? '', path: w.path ?? '', id: w.id ?? '' }))
      }

      /** 文件里写死的值（null = 跟随默认），给面板区分「专值」和「跟随默认」 */
      const explicitMap = () => {
        const file = readConfigFile()
        const out = new Map()
        const list = Array.isArray(file?.workspaces) ? file.workspaces : []
        for (const entry of list) {
          if (!entry || typeof entry !== 'object') continue
          const name = typeof entry.name === 'string' ? entry.name.trim() : ''
          if (name === '') continue
          out.set(name, isBlank(entry.maxSteps) ? null : toPositiveInt(entry.maxSteps, null))
        }
        return out
      }

      const snapshot = () => {
        const live = currentConfig()
        const explicit = explicitMap()
        return {
          ok: true,
          source: live.source,
          defaultMaxSteps: live.def,
          workspaces: [...live.map.entries()].map(([name, maxSteps]) => ({
            name,
            maxSteps,
            /** null = 跟着默认走；数字 = 该工作区专值 */
            override: explicit.has(name) ? explicit.get(name) : null,
          })),
          available: rosterOf(),
          minSteps: live.minSteps,
          cooldownMinutes: live.cooldownMinutes,
          maxRotations: live.maxRotations,
          dryRun: live.dryRun,
          /** 因连续触发被暂停的工作区（名字） */
          paused: [...paused].map((id) => rosterOf().find((w) => w.id === id)?.name ?? id),
          configFile: CONFIG_FILE,
          log: logTail(20),
        }
      }

      const disposeConfig = ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-rotate/config',
        handler: async (req, res) => {
          if (!guard(req, res)) return
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')

          if (req.method === 'GET') {
            res.statusCode = 200
            res.end(JSON.stringify(snapshot()))
            return
          }
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ ok: false, error: '仅支持 GET / POST' }))
            return
          }

          try {
            const body = await readBody(req)
            const parsed = JSON.parse(body === '' ? '{}' : body)
            /** 解除「连续触发暂停」：带 clearPause:true 提交即可 */
            if (parsed?.clearPause === true) {
              paused.clear()
              saveState()
              log('已按请求清空暂停名单（clearPause），各工作区恢复换新')
            }
            /** 空名单 = 全部工作区都不生效，很容易被「面板没读全就点保存」误触发，要求显式确认 */
            if (Array.isArray(parsed?.workspaces) && parsed.workspaces.length === 0 && parsed.confirmEmpty !== true) {
              res.statusCode = 400
              res.end(
                JSON.stringify({
                  ok: false,
                  error: '名单为空会关闭所有工作区；确实要清空请带 confirmEmpty: true',
                }),
              )
              return
            }
            const next = sanitizeConfig(parsed, readConfigFile() ?? {})
            writeFileAtomic(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n')
            const warnings = configWarnings(normalizeConfig(next))
            const detail = next.workspaces
              .map((w) => `${w.name}=${w.maxSteps ?? '默认'}`)
              .join('、')
            log(
              `设置已更新：默认 ${next.defaultMaxSteps} 步；名单 ${next.workspaces.length} 个${
                detail === '' ? '' : `（${detail}）`
              }；保护闸 minSteps=${next.minSteps} 冷却=${next.cooldownMinutes}min 上限 ${next.maxRotations} 次` +
                `${next.dryRun ? '；试运行开' : ''}`,
            )
            for (const warning of warnings) log(`配置警告：${warning}`)
            res.statusCode = 200
            res.end(JSON.stringify({ ...snapshot(), warnings }))
          } catch (error) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
          }
        },
      })
      keepRoute(disposeConfig)
    } catch (error) {
      log('配置路由注册失败（设置面板将不可用）:', error?.message ?? error)
    }

    // ---- 一轮结束才判定，不打断进行中的任务 ----
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'turn/end') return
      Promise.resolve()
        .then(() => rotateIfDue(session))
        .catch((error) => log('换新失败:', error?.message ?? error))
    })

    function workspaceOf(sessionId, cwd) {
      let list = []
      try {
        list = ctx.workspaceRegistry.list() ?? []
      } catch {
        return undefined
      }
      for (const workspace of list) {
        let ids = []
        try {
          ids = workspace.sessionIds ?? []
        } catch {
          ids = []
        }
        if (Array.isArray(ids) && ids.includes(sessionId)) return workspace
      }
      if (typeof cwd === 'string' && cwd !== '') {
        for (const workspace of list) if (workspace.path === cwd) return workspace
      }
      return undefined
    }

    // 每个会话上一轮结束时的累计步数：相邻两轮相减 = 上一轮实际用了多少步（进程内即可）
    const lastSteps = new Map()
    // 每个工作区最近 3 轮的实测增量：跨会话保留，新会话首轮就有先验，不再拿 steps 当上界
    const wsDeltas = new Map()
    // 冷却 / 连续换新 / 暂停：落盘到 state.json，重启不清零（否则重启就是绕过防护）
    const lastRotateAt = new Map()
    const rotateStamps = new Map()
    const paused = new Set()
    // dry-run 已记过日志的「会话@步数」，同一档只记一次
    const dryLogged = new Set()

    function loadState() {
      try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
        if (!parsed || typeof parsed !== 'object') return
        for (const [id, ts] of Object.entries(parsed.lastRotateAt ?? {})) {
          if (Number.isFinite(ts)) lastRotateAt.set(id, ts)
        }
        for (const [id, stamps] of Object.entries(parsed.rotateStamps ?? {})) {
          if (Array.isArray(stamps)) rotateStamps.set(id, stamps.filter((t) => Number.isFinite(t)))
        }
        for (const id of Array.isArray(parsed.paused) ? parsed.paused : []) {
          if (typeof id === 'string' && id !== '') paused.add(id)
        }
        for (const [id, deltas] of Object.entries(parsed.wsDeltas ?? {})) {
          if (!Array.isArray(deltas)) continue
          const clean = deltas.filter((n) => Number.isFinite(n) && n >= 0).slice(-3)
          if (clean.length > 0) wsDeltas.set(id, clean)
        }
        if (paused.size > 0 || lastRotateAt.size > 0) {
          log(`已恢复 state.json：暂停工作区 ${paused.size} 个、冷却记录 ${lastRotateAt.size} 条`)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') log('读 state.json 失败，从空状态开始:', error?.message ?? error)
      }
    }

    function saveState() {
      try {
        const payload = {
          lastRotateAt: Object.fromEntries(lastRotateAt),
          rotateStamps: Object.fromEntries(rotateStamps),
          paused: [...paused],
          wsDeltas: Object.fromEntries(wsDeltas),
        }
        writeFileAtomic(STATE_FILE, JSON.stringify(payload, null, 2))
      } catch (error) {
        log('写 state.json 失败:', error?.message ?? error)
      }
    }

    loadState()

    async function rotateIfDue(session) {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || done.has(sessionId)) return
      const header = session.header ?? {}
      if (header.parentSession !== undefined) return // 子会话不管

      const workspace = workspaceOf(sessionId, header.cwd)
      if (!workspace) {
        log(`跳过 ${sessionId}：找不到所属工作区（cwd=${header.cwd ?? '无'}）`)
        return
      }
      const title = workspace.title
      const cfg = currentConfig()
      const limit = cfg.map.get(title)
      if (limit === undefined) return // 不在名单里 = 不生效

      let steps = 0
      try {
        steps = Number(ctx.sessionProjections.stateOf(session, 'sessionStats')?.steps ?? 0)
      } catch (error) {
        log(`读 steps 失败 ${sessionId}:`, error?.message ?? error)
        steps = 0
      }

      // 这个工作区可以单独覆盖保护闸，缺省跟随顶层
      const ov = cfg.overrides?.get(title) ?? {}
      const minSteps = ov.minSteps ?? cfg.minSteps
      const cooldownMinutes = ov.cooldownMinutes ?? cfg.cooldownMinutes
      const maxRotations = ov.maxRotations ?? cfg.maxRotations

      const prevSteps = lastSteps.get(sessionId)
      lastSteps.set(sessionId, steps)

      // 近 3 轮增量（跨会话）交给 decideRotate 做滑动平均，本轮实测也进窗口
      const recentDeltas = wsDeltas.get(workspace.id) ?? []
      const verdict = decideRotate({ steps, limit, prevSteps, recentDeltas, minSteps })
      if (verdict.measured !== null) {
        wsDeltas.set(workspace.id, [...recentDeltas, verdict.measured].slice(-3))
        saveState()
      }

      const where =
        `判定 ${sessionId}：工作区「${title}」steps=${steps} limit=${limit} minSteps=${minSteps}`

      const dryLog = (extra) => {
        const key = `${sessionId}@${steps}`
        if (dryLogged.has(key)) return
        dryLogged.add(key)
        if (dryLogged.size > 500) dryLogged.clear() // 长期开试运行时别让这个集合无限涨
        log(`${where} [dry-run] 只记日志不换：${verdict.reason}${extra}`)
      }

      // 闸 1：该工作区因连续换新被暂停
      if (paused.has(workspace.id)) {
        if (cfg.dryRun) dryLog('（该工作区已暂停，真实运行同样跳过）')
        else log(`${where} 跳过：该工作区已因连续换新暂停（POST /dsh-session-rotate/config 带 clearPause:true 可恢复）`)
        return
      }

      if (!verdict.shouldRotate) {
        log(
          `${where} 本轮 +${verdict.measured ?? '?'} 放行` +
            (verdict.blocked === 'minSteps'
              ? `（未达最小步数 ${minSteps}，一律不换）`
              : `（预判值 ${verdict.delta === null ? '?' : steps + verdict.delta}）`),
        )
        return
      }

      // 试运行：判据一命中就先记一条，后面冷却/连续闸放不放行都不影响这行观测
      if (cfg.dryRun) {
        const cooledMs = Date.now() - (lastRotateAt.get(workspace.id) ?? 0)
        const coolLeft = cooldownMinutes * 60_000 - cooledMs
        dryLog(coolLeft > 0 ? `（冷却中，还剩 ${Math.ceil(coolLeft / 1000)}s，真实运行会跳过）` : '')
        return
      }

      // 闸 2：冷却期内同一工作区最多换 1 次
      const cooldownMs = cooldownMinutes * 60_000
      const cooled = Date.now() - (lastRotateAt.get(workspace.id) ?? 0)
      if (cooled < cooldownMs) {
        log(`${where} 跳过：冷却中（距上次换新 ${Math.round(cooled / 1000)}s < ${cooldownMinutes}min），本该换：${verdict.reason}`)
        return
      }

      // 闸 3：连续触发上限（冷却窗口 x 上限次数 内换满就暂停该工作区）
      const now = Date.now()
      const burstWindowMs = cooldownMs * maxRotations
      const stamps = (rotateStamps.get(workspace.id) ?? []).filter((t) => now - t <= burstWindowMs)
      if (stamps.length >= maxRotations) {
        paused.add(workspace.id)
        rotateStamps.set(workspace.id, stamps)
        saveState()
        log(
          `暂停换新：工作区「${title}」在 ${Math.round(burstWindowMs / 60_000)} 分钟内已连续换新 ${stamps.length} 次` +
            `（上限 ${maxRotations}），该工作区暂停，本次不换。恢复：POST /dsh-session-rotate/config 带 clearPause:true，或删 state.json`,
        )
        return
      }

      done.add(sessionId)
      lastSteps.delete(sessionId)
      log(`${where} ${verdict.over ? '越限触发' : '预判触发'}：${verdict.reason}`)
      await rotate(session, workspace, steps, limit, verdict.reason)
    }

    async function rotate(session, workspace, steps, limit, reason) {
      const oldId = session.id
      const summary = buildSummary(session, workspace, steps, limit, reason)

      let created
      try {
        created = await ctx.sessionController.commands.create({ workspaceId: workspace.id })
      } catch (error) {
        log('新建会话失败，本次放弃:', error?.message ?? error)
        return
      }
      const newId = created?.sessionId ?? created?.id
      if (typeof newId !== 'string' || newId === '') {
        log('新建会话返回里没有 sessionId:', JSON.stringify(created))
        return
      }

      // 冷却 / 连续触发计数只记真正换成的（建会话失败不计）
      lastRotateAt.set(workspace.id, Date.now())
      rotateStamps.set(workspace.id, [...(rotateStamps.get(workspace.id) ?? []), Date.now()])
      saveState()

      try {
        const channel = await deliver(newId, summary)
        log(`摘要已送达（通道 ${channel}）→ ${newId}`)
      } catch (error) {
        log('发送交接摘要失败（新会话已建好，摘要未送达）:', error?.message ?? error)
      }

      writeHeir(oldId, newId)

      try {
        await ctx.workspaceRegistry.archiveSession(oldId, { stopActivity: true })
      } catch (error) {
        log('归档旧会话失败:', error?.message ?? error)
      }

      state.pending = { sessionId: newId, workspaceId: workspace.id, from: oldId, at: Date.now() }
      log(`换新：${oldId}（${steps}/${limit} 步，${reason}）→ ${newId}，工作区「${workspace.title}」`)
    }

    function buildSummary(session, workspace, steps, limit, reason) {
      let events = []
      try {
        events = session.ownEvents() ?? []
      } catch {
        events = []
      }

      const users = userTexts(events)
      let lastReply = ''
      for (const event of events) {
        if (event?.type !== 'assistant/message') continue
        const text = textOf(event)
        if (text.trim() !== '') lastReply = text
      }

      const goal = users.length > 0 ? users[users.length - 1] : '（未取到用户指令）'
      const finished = users.slice(Math.max(0, users.length - 4), Math.max(0, users.length - 1)).reverse()
      const next = lastReply !== '' ? lastReply.slice(-LINE_CUT) : '（上一轮没有文本回复）'

      const lines = [
        HANDOFF_MARK,
        `以下内容是上一会话的记录；除用户下一条新指令外，不要自行执行「下一步」里的内容。`,
        `工作区：${workspace.title}`,
        `步数：${steps}/${limit}（上一会话已归档）`,
        `交接原因：${reason ?? '越限'}（上限是软上限，见 README）`,
        `当前目标：${oneLine(goal, LINE_CUT)}`,
        '更早的用户指令（只是历史记录，不是待办）：',
        ...(finished.length > 0
          ? finished.map((text) => `- ${oneLine(text, LIST_CUT)}`)
          : ['- （无更早的用户指令）']),
        `上一会话最后的回复：${oneLine(next, LINE_CUT)}`,
        `旧会话：${session.id}`,
      ]
      return lines.slice(0, 16).join('\n')
    }

    function writeHeir(fromId, toId) {
      try {
        let current = {}
        try {
          const parsed = JSON.parse(fs.readFileSync(HEIRS_FILE, 'utf8'))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
        } catch {
          current = {}
        }
        current[fromId] = toId
        current.__updatedAt = Date.now()
        writeFileAtomic(HEIRS_FILE, JSON.stringify(current, null, 2))
        log(`继承表已更新：${fromId} → ${toId}（${HEIRS_FILE}）`)
      } catch (error) {
        log('写继承表失败:', error?.message ?? error)
      }
    }
  },
}

/** 给单测用：配置清洗/归一化是纯函数，不走宿主 */
export { normalizeConfig, sanitizeConfig, configWarnings, workspaceOverrides }

