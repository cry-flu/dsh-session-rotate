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
/** 交接摘要里「上一会话最后的回复」保留的字数：够读完全文，又不至于把摘要撑爆 */
const REPLY_CUT = 4000
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
    archiveOnRotate: c.archiveOnRotate !== false,
    /** 换新后自动把界面切到新会话；false = 只建会话不跳转，旧会话保持当前显示 */
    autoSwitch: c.autoSwitch !== false,
    /**
     * 到点归档旧会话时，先让界面切到新会话再归档。
     * 只在 autoSwitch=false 且 deferArchiveMinutes>0 时起作用（换新时就跳过的新会话，到点再补这一跳）。
     * false = 到点只归档不切，旧会话一归档在界面上就成了「暂时无法查看」。
     */
    switchOnArchive: c.switchOnArchive !== false,
    /** 换新后旧会话先留多久再自动归档（分钟）；0 = 立刻归档，等于不留回看窗口 */
    deferArchiveMinutes: deferArchiveOf(c.deferArchiveMinutes),
  }
}

/**
 * 延迟归档分钟数：缺省 0（立即归档，与 1.0.0 行为一致）；0 合法；非法值回落默认。
 * 1.2.x 曾把缺省设成 5，1.3.0 按「默认必须与 1.0.0 一致」改回 0。
 */
function deferArchiveOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

/**
 * 安全闸：只允许归档/取消归档「本插件换出来的」会话。
 * own 是 state.json 里 ownSessions 的集合，id 是要动的会话。
 * 不是自己换出来的（用户手动建的、历史的、别的插件的）一律不碰。
 */
export function canTouchOwn(own, id) {
  if (typeof id !== 'string' || id === '') return false
  if (!own) return false
  return own instanceof Set ? own.has(id) : Array.isArray(own) ? own.includes(id) : false
}

/** ownSessions 的保留上限：只是为了不让 state.json 无限长（每条就一个会话 id）。 */
export const OWN_CAP = 200

/** 到点归档前留给客户端轮询跳转的时间：客户端每 2.5 秒拉一次 /state，3 秒足够它跳完再归档。 */
const SWITCH_LEAD_MS = 3000

/** 到点归档被「还有活在跑」挡下之后，过多久再问一次宿主。 */
const RETRY_MS = 60_000

/** 最多顺延几次（≈RETRY_MS × 次数）。用完了就放弃归档、会话原样留着，绝不改成强杀。 */
export const MAX_DEFERRALS = 10

/** 上一轮把归档挡下来了：这轮一结束再等这么久就重查，别让人干等一个 RETRY_MS。 */
const TURN_END_GRACE_MS = 3000

/**
 * 到点归档这一步怎么走，纯函数便于单测。
 * activity = 宿主 `workspace/session-activity` 的返回，非空表示这个会话还有活在跑
 * （`turn` / `job` / `subagent` / `schedule` 任意一族）。
 * 返回 'archive'（可以归档了）| 'defer'（还有活，顺延重查）| 'giveup'（顺延次数用完，放弃归档）。
 * 任何分支都不会回落到 `stopActivity: true` —— 掐断正在跑的轮不是这个插件的权力。
 */
export function deferredStep(activity, retries, maxDeferrals = MAX_DEFERRALS) {
  const busy = Array.isArray(activity) && activity.length > 0
  if (!busy) return 'archive'
  const used = Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0
  const cap = Number.isFinite(maxDeferrals) && maxDeferrals >= 0 ? Math.floor(maxDeferrals) : MAX_DEFERRALS
  return used >= cap ? 'giveup' : 'defer'
}

/**
 * 裁剪 ownSessions 名单，纯函数便于单测。
 * list 顺序 = 登记顺序（老的在前）；keep 是「还在用」的 id（延迟归档待办），无论多老都钉住不删。
 * 超出 cap 时只从最老的一端删，返回顺序保持原样。
 */
export function trimOwnSessions(list, keep, cap = OWN_CAP) {
  const ids = Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id !== '') : []
  const keepSet = keep instanceof Set ? keep : new Set(Array.isArray(keep) ? keep : [])
  const max = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : OWN_CAP
  const tail = ids.length <= max ? ids : ids.slice(ids.length - max)
  const pinned = ids.filter((id) => keepSet.has(id))
  const survivor = new Set([...tail, ...pinned])
  return ids.filter((id) => survivor.has(id))
}

/**
 * 换新后旧会话怎么处理，纯函数便于单测。
 * 返回 'none'（不归档）| 'deferred'（延迟 N 分钟）| 'now'（立刻归档）。
 * 任何情况下都不去动「不是自己换出来的」会话 —— 这里只管策略，归档前还要过 canTouchOwn。
 * autoSwitch=false（界面没跳）时：只有在「归档到点自动切到新会话」开着、并且确实留了回看窗口时才延迟归档；
 * 否则一律 'none' —— 人还停在旧会话上看，归档它就成了「暂时无法查看」。
 */
export function archivePlan(cfg, ownIds, oldId) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  if (!canTouchOwn(ownIds, oldId)) return 'none'
  if (c.archiveOnRotate === false) return 'none'
  const minutes = deferArchiveOf(c.deferArchiveMinutes)
  if (c.autoSwitch === false) {
    // 界面没跳：到点必须有人把界面切走，才敢归档
    if (c.switchOnArchive === false) return 'none'
    // 没留回看窗口就没有「到点」这回事，保持不归档
    return minutes > 0 ? 'deferred' : 'none'
  }
  return minutes > 0 ? 'deferred' : 'now'
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
    archiveOnRotate: c.archiveOnRotate === undefined ? old.archiveOnRotate !== false : c.archiveOnRotate !== false,
    autoSwitch: c.autoSwitch === undefined ? old.autoSwitch !== false : c.autoSwitch !== false,
    switchOnArchive:
      c.switchOnArchive === undefined ? old.switchOnArchive !== false : c.switchOnArchive !== false,
    deferArchiveMinutes:
      c.deferArchiveMinutes === undefined
        ? deferArchiveOf(old.deferArchiveMinutes)
        : deferArchiveOf(c.deferArchiveMinutes),
  }
}

/** 步数上限低于「最低步数」时这道闸永远不生效，值得提示 */
function configWarnings(cfg) {
  const out = []
  if (
    cfg.autoSwitch === false &&
    cfg.switchOnArchive === false &&
    (cfg.archiveOnRotate !== false || deferArchiveOf(cfg.deferArchiveMinutes) > 0)
  ) {
    out.push(
      '已同时关掉「换新后自动跳到新会话」和「归档到点时自动跳到新会话」：上面两项归档设置一律不生效，旧会话一定保留' +
        '（人还停在旧会话上，归档它就看不成了）',
    )
  }
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

/** 交接摘要里的上一轮正文：默认整段照贴，超过 REPLY_CUT 才头尾各留一段 */
function clipReply(text) {
  if (text.length <= REPLY_CUT) return text
  const headLen = Math.floor(REPLY_CUT * 0.75)
  const tailLen = REPLY_CUT - headLen
  return `${text.slice(0, headLen)}\n\n……（中间省略 ${text.length - REPLY_CUT} 字，完整内容在旧会话）……\n\n${text.slice(-tailLen)}`
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

/**
 * 交接摘要里「旧会话现在在哪」这一句，三种状态各自说清楚：
 * 立刻归档 / 先留 N 分钟再归档 / 永不归档（留在列表里）
 */
export function archiveNote(archive) {
  const a = archive && typeof archive === 'object' ? archive : { archiveOnRotate: archive !== false }
  if (a.archiveOnRotate === false) return '上一会话未归档，仍在会话列表里'
  // 界面没跳时：只有「到点自动切到新会话」开着并留了回看窗口，才会真的归档
  if (a.autoSwitch === false && a.switchOnArchive === false) return '上一会话未归档，仍在会话列表里'
  const minutes = deferArchiveOf(a.deferArchiveMinutes)
  if (minutes > 0) {
    return a.autoSwitch === false
      ? `上一会话先留在列表里 ${minutes} 分钟（可回看最后一条回复），到点会先把你切到本会话再归档`
      : `上一会话先留在列表里 ${minutes} 分钟（可回看最后一条回复），到点自动归档`
  }
  return a.autoSwitch === false ? '上一会话未归档，仍在会话列表里' : '上一会话已归档'
}

/**
 * 交接摘要：换新时投给新会话的第一条 user 消息。纯本地模板，不调模型。
 * 头部长摘要 ≤16 行；末尾原样附上上一轮助手回复全文，换新后不必回旧会话翻。
 */
export function summaryText(session, workspace, steps, limit, reason, archive) {
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
  const reply = lastReply.trim() !== '' ? lastReply.trim() : '（上一轮没有文本回复）'

  const lines = [
    HANDOFF_MARK,
    `以下内容是上一会话的记录；除用户下一条新指令外，不要自行执行「下一步」里的内容。`,
    `工作区：${workspace?.title ?? '（未知工作区）'}`,
    `步数：${steps}/${limit}（${archiveNote(archive)}）`,
    `交接原因：${reason ?? '越限'}（上限是软上限，见 README）`,
    `当前目标：${oneLine(goal, LINE_CUT)}`,
    '更早的用户指令（只是历史记录，不是待办）：',
    ...(finished.length > 0
      ? finished.map((text) => `- ${oneLine(text, LIST_CUT)}`)
      : ['- （无更早的用户指令）']),
    `旧会话：${session?.id ?? '?'}`,
  ]
  const head = lines.slice(0, 16).join('\n')

  return [
    head,
    '',
    `上一会话最后的回复（全文 ${reply.length} 字，原样贴在这里，不必回旧会话翻）：`,
    '<<<',
    clipReply(reply),
    '>>>',
  ].join('\n')
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
            autoSwitch: live.autoSwitch,
            switchOnArchive: live.switchOnArchive,
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
            // 自检建的会话也登记在册，归档时才算「自己的」
            ownSessions.add(sid)
            trimOwnInPlace()
            saveState()
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
          archiveOnRotate: live.archiveOnRotate,
          autoSwitch: live.autoSwitch,
          switchOnArchive: live.switchOnArchive,
          deferArchiveMinutes: live.deferArchiveMinutes,
          /** 还没到点归档的旧会话（换新后最多留 N 分钟） */
          deferred: [...deferredArchives.entries()].map(([fromId, entry]) => ({
            sessionId: fromId,
            to: entry.toId,
            deadline: entry.deadline,
          })),
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
                `${next.dryRun ? '；试运行开' : ''}` +
                `${next.autoSwitch ? '' : '；不跳转新会话'}` +
                `${
                  next.autoSwitch === false
                    ? next.archiveOnRotate === false
                      ? '；换新不归档旧会话'
                      : next.switchOnArchive === false
                        ? '；旧会话一律保留（不跳转也不切界面，无法归档）'
                        : `；旧会话保留 ${next.deferArchiveMinutes} 分钟，到点先切到新会话再归档`
                    : next.archiveOnRotate
                      ? `；旧会话保留 ${next.deferArchiveMinutes} 分钟再归档`
                      : '；换新不归档旧会话'
                }`,
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
      const sid = session?.id
      if (typeof sid === 'string') {
        const entry = deferredArchives.get(sid)
        if (entry) {
          // 被「还有活在跑」挡下过：轮一结束就补做归档，不用白等一个 RETRY_MS；
          // 没被挡过的（人正在旧会话里看/发消息）：照旧把保留期顺延，别在他正看时归档
          if (Number(entry.retries) > 0) nudgeDeferred(sid)
          else refreshDeferred(sid)
        }
      }
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
    // 延迟归档：fromId -> { toId, at, deadline, retries }；落盘到 state.json，重启后补做
    const deferredArchives = new Map()
    const deferredTimers = new Map()
    // 正在归档中的 fromId：定时器和 turn/end 补做可能撞在一起，进来就占位，别归档两次
    const deferredBusy = new Set()
    // 本插件换出来的旧会话（安全原则）：归档 / 取消归档只允许作用于这些 ID，别的一律不碰
    const ownSessions = new Set()
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
        for (const id of Array.isArray(parsed.ownSessions) ? parsed.ownSessions : []) {
          if (typeof id === 'string' && id !== '') ownSessions.add(id)
        }
        for (const [id, deltas] of Object.entries(parsed.wsDeltas ?? {})) {
          if (!Array.isArray(deltas)) continue
          const clean = deltas.filter((n) => Number.isFinite(n) && n >= 0).slice(-3)
          if (clean.length > 0) wsDeltas.set(id, clean)
        }
        for (const [fromId, entry] of Object.entries(parsed.deferredArchives ?? {})) {
          if (!entry || typeof entry !== 'object') continue
          if (typeof entry.toId !== 'string') continue
          const deadline = Number(entry.deadline)
          deferredArchives.set(fromId, {
            toId: entry.toId,
            at: Number(entry.at) || 0,
            deadline: Number.isFinite(deadline) ? deadline : Date.now(),
            retries: Number.isFinite(Number(entry.retries)) && Number(entry.retries) > 0 ? Math.floor(Number(entry.retries)) : 0,
          })
        }
        if (deferredArchives.size > 0) {
          log(`已恢复 state.json：待归档旧会话 ${deferredArchives.size} 个，按原定时间补做`)
          for (const fromId of deferredArchives.keys()) armDeferredTimer(fromId)
        }
        if (paused.size > 0 || lastRotateAt.size > 0) {
          log(`已恢复 state.json：暂停工作区 ${paused.size} 个、冷却记录 ${lastRotateAt.size} 条`)
        }
        trimOwnInPlace()
      } catch (error) {
        if (error?.code !== 'ENOENT') log('读 state.json 失败，从空状态开始:', error?.message ?? error)
      }
    }

    /** 就地裁剪 ownSessions：保留最近 OWN_CAP 个，延迟归档待办的钉住不动 */
    function trimOwnInPlace() {
      const before = ownSessions.size
      if (before === 0) return
      const kept = trimOwnSessions([...ownSessions], new Set(deferredArchives.keys()))
      if (kept.length === before) return
      ownSessions.clear()
      for (const id of kept) ownSessions.add(id)
      log(`ownSessions 裁剪：${before} → ${kept.length}（钉住待归档 ${deferredArchives.size} 个）`)
    }

    function saveState() {
      try {
        const payload = {
          lastRotateAt: Object.fromEntries(lastRotateAt),
          rotateStamps: Object.fromEntries(rotateStamps),
          paused: [...paused],
          ownSessions: [...ownSessions],
          wsDeltas: Object.fromEntries(wsDeltas),
          deferredArchives: Object.fromEntries(deferredArchives),
        }
        writeFileAtomic(STATE_FILE, JSON.stringify(payload, null, 2))
      } catch (error) {
        log('写 state.json 失败:', error?.message ?? error)
      }
    }

    /** 给待归档的旧会话挂定时器：到点（deferArchiveMinutes 之后）自动归档 */
    function armDeferredTimer(fromId) {
      const entry = deferredArchives.get(fromId)
      if (!entry) return
      const old = deferredTimers.get(fromId)
      if (old) clearTimeout(old)
      const left = Math.max(0, entry.deadline - Date.now())
      const timer = setTimeout(() => {
        deferredTimers.delete(fromId)
        Promise.resolve()
          .then(() => archiveDeferred(fromId, '保留期到点'))
          .catch((error) => log(`延迟归档异常：${fromId}`, error?.message ?? error))
      }, left)
      if (typeof timer.unref === 'function') timer.unref()
      deferredTimers.set(fromId, timer)
    }

    /** 保留期内旧会话又被用到（用户点进去发了一句话）：重新计时，别在他正看的时候归档 */
    function refreshDeferred(fromId) {
      const entry = deferredArchives.get(fromId)
      if (!entry) return
      const minutes = currentConfig().deferArchiveMinutes
      if (minutes <= 0) return
      entry.deadline = Date.now() + minutes * 60_000
      entry.at = Date.now()
      deferredArchives.set(fromId, entry)
      saveState()
      armDeferredTimer(fromId)
      log(`旧会话仍在被使用，归档时间顺延 ${minutes} 分钟：${fromId}`)
    }

    /** 摘掉待办条目：只有「归档成功」「放弃归档」「不是自己的会话」这三种情况才摘 */
    function forgetDeferred(fromId) {
      deferredArchives.delete(fromId)
      const timer = deferredTimers.get(fromId)
      if (timer) clearTimeout(timer)
      deferredTimers.delete(fromId)
      saveState()
    }

    /** 顺延一次：条目不摘，改成 RETRY_MS 之后再问，返回累计顺延次数 */
    function deferOnce(fromId, entry) {
      const used = Number.isFinite(entry.retries) && entry.retries > 0 ? Math.floor(entry.retries) : 0
      entry.retries = used + 1
      entry.deadline = Date.now() + RETRY_MS
      deferredArchives.set(fromId, entry)
      saveState()
      armDeferredTimer(fromId)
      return entry.retries
    }

    /** 之前因为「还有活在跑」被挡下过：这轮一结束就提前重查，别让人白等一个 RETRY_MS */
    function nudgeDeferred(fromId) {
      const entry = deferredArchives.get(fromId)
      if (!entry) return
      entry.deadline = Date.now() + TURN_END_GRACE_MS
      deferredArchives.set(fromId, entry)
      saveState()
      armDeferredTimer(fromId)
    }

    /**
     * 真正归档：先问宿主这个会话还有没有活在跑，有就顺延，绝不掐断进行中的轮。
     * 判据交给宿主自己算（`workspace/session-activity` 瀑布），本插件不另记一份口水账。
     * 并发保护：定时器与 turn/end 补做可能同时到，同一条待办只让一个走。
     */
    async function archiveDeferred(fromId, why) {
      if (!deferredArchives.has(fromId)) return
      if (deferredBusy.has(fromId)) return
      deferredBusy.add(fromId)
      try {
        await archiveDeferredOnce(fromId, why)
      } catch (error) {
        log(`延迟归档异常：${fromId}`, error?.message ?? error)
      } finally {
        deferredBusy.delete(fromId)
      }
    }

    async function archiveDeferredOnce(fromId, why) {
      const entry = deferredArchives.get(fromId)
      if (!entry) return

      // 安全原则：不是本插件换出来的会话，绝不归档（历史上留错的条目也在这里被挡掉）
      if (!canTouchOwn(ownSessions, fromId)) {
        forgetDeferred(fromId)
        log(`跳过归档：${fromId} 不在本插件换出的会话名单里，未动它（${why}）`)
        return
      }

      // 探活放在「先切界面」之前：白跳一次界面比顺延一次更烦人
      let activity = []
      if (typeof ctx.waterfall === 'function') {
        try {
          activity = (await ctx.waterfall('workspace/session-activity', { sessionId: fromId }, () => [])) ?? []
        } catch (error) {
          log(`探活失败，这一次按「还有活」处理：${fromId}`, error?.message ?? error)
          activity = [{ kind: 'unknown' }]
        }
      } else {
        // 宿主没有这道瀑布：不猜，直接走归档（archiveSession 自身会按活跃情况抛错，那条 catch 接得住）
        log(`宿主没有 workspace/session-activity 瀑布，跳过探活直接归档：${fromId}`)
      }

      const retries = Number.isFinite(entry.retries) && entry.retries > 0 ? Math.floor(entry.retries) : 0
      const list = Array.isArray(activity) ? activity : []
      const kinds = [...new Set(list.map((item) => item?.kind).filter((kind) => typeof kind === 'string' && kind !== ''))]
      const kindText = kinds.length > 0 ? `；活跃=${kinds.join('/')}` : ''
      const step = deferredStep(list, retries)

      if (step === 'giveup') {
        forgetDeferred(fromId)
        log(`旧会话一直有活，放弃到点归档、会话原样留着：${fromId}（已顺延 ${retries} 次，${why}${kindText}）`)
        return
      }
      if (step === 'defer') {
        const used = deferOnce(fromId, entry)
        log(`旧会话还有活在跑，到点归档顺延 ${Math.round(RETRY_MS / 1000)} 秒：${fromId}（第 ${used}/${MAX_DEFERRALS} 次顺延，${why}${kindText}）`)
        return
      }

      // 换新时界面没跳（autoSwitch=false）：到点先把人切到新会话，再归档 ——
      // 否则他正看着的会话一归档就成了「暂时无法查看」。客户端 2.5 秒轮询一次，留 SWITCH_LEAD_MS 够用。
      const live = currentConfig()
      const lead =
        live.autoSwitch === false &&
        live.switchOnArchive !== false &&
        typeof entry.toId === 'string' &&
        entry.toId !== ''
      if (lead) {
        state.pending = {
          sessionId: entry.toId,
          workspaceId: entry.workspaceId,
          from: fromId,
          at: Date.now(),
          switch: true,
          reason: 'archive',
        }
        log(`到点归档前先把界面切到新会话 ${entry.toId}（${SWITCH_LEAD_MS / 1000} 秒后归档 ${fromId}）`)
        await new Promise((resolve) => setTimeout(resolve, SWITCH_LEAD_MS))
      }

      try {
        // 不传 stopActivity：宿主会自己再过一遍活跃检查，真被抢在中间（正好又开了一轮）就抛
        // WorkspaceActiveSessionError，这里接住继续顺延 —— 绝不改成掐断
        await ctx.workspaceRegistry.archiveSession(fromId)
        forgetDeferred(fromId)
        log(`旧会话已到点归档：${fromId}（${why}，新会话 ${entry.toId}）` + (retries > 0 ? `；顺延 ${retries} 次后归档` : '') + (lead ? '；界面已切到新会话' : ''))
      } catch (error) {
        if (error?.name === 'WorkspaceActiveSessionError') {
          if (retries >= MAX_DEFERRALS) {
            forgetDeferred(fromId)
            log(`旧会话一直有活，放弃到点归档、会话原样留着：${fromId}（已顺延 ${retries} 次，${why}）`)
            return
          }
          const used = deferOnce(fromId, entry)
          log(`归档被宿主挡下（这一会话还有活），继续顺延 ${Math.round(RETRY_MS / 1000)} 秒：${fromId}（第 ${used}/${MAX_DEFERRALS} 次顺延，${why}）`)
          return
        }
        forgetDeferred(fromId)
        log(`旧会话到点归档失败（会话仍是未归档状态）：${fromId}`, error?.message ?? error)
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
      const live = currentConfig()
      const archiveOnRotate = live.archiveOnRotate
      const deferMinutes = live.deferArchiveMinutes
      const autoSwitch = live.autoSwitch
      const switchOnArchive = live.switchOnArchive
      const summary = buildSummary(session, workspace, steps, limit, reason, {
        archiveOnRotate,
        deferArchiveMinutes: deferMinutes,
        autoSwitch,
        switchOnArchive,
      })

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

      // 安全原则：先登记「这个旧会话是本插件换出来的」，之后归档只认登记过的 ID
      ownSessions.add(oldId)
      trimOwnInPlace()
      saveState()

      const plan = archivePlan(
        { archiveOnRotate, deferArchiveMinutes: deferMinutes, autoSwitch, switchOnArchive },
        ownSessions,
        oldId,
      )

      if (plan === 'none') {
        const why = !canTouchOwn(ownSessions, oldId)
          ? `跳过归档：${oldId} 不在本插件换出的会话名单里，未动它`
          : archiveOnRotate === false
            ? `按配置保留旧会话未归档：${oldId}（archiveOnRotate=false）`
            : autoSwitch === false && switchOnArchive === false
              ? `按配置保留旧会话未归档：${oldId}（autoSwitch=false 且 switchOnArchive=false，到点没人切界面，归档就看不成了）`
              : autoSwitch === false
                ? `按配置保留旧会话未归档：${oldId}（autoSwitch=false 且「归档前先留」=0，没有可切的时间点）`
                : `跳过归档：${oldId} 未动它`
        log(why)
      } else if (plan === 'deferred') {
        // 旧会话先留在侧边栏，够人回看最后一条回复，到点才归档
        deferredArchives.set(oldId, {
          toId: newId,
          workspaceId: workspace.id,
          at: Date.now(),
          deadline: Date.now() + deferMinutes * 60_000,
        })
        saveState()
        armDeferredTimer(oldId)
        log(
          `旧会话先留在列表里 ${deferMinutes} 分钟，可回看最后一条回复：${oldId}` +
            `（到点自动归档；不想归档就取消勾选「换新时归档旧会话」，想立刻归档就把分钟数填 0）` +
            (autoSwitch === false && switchOnArchive !== false ? `；到点会先把界面切到新会话 ${newId} 再归档` : ''),
        )
      } else {
        try {
          await ctx.workspaceRegistry.archiveSession(oldId, { stopActivity: true })
        } catch (error) {
          log('归档旧会话失败:', error?.message ?? error)
        }
      }

      state.pending = {
        sessionId: newId,
        workspaceId: workspace.id,
        from: oldId,
        at: Date.now(),
        /** 这一跳要不要真跳，由服务端定：客户端只认这个布尔 */
        switch: autoSwitch !== false,
        reason: 'rotate',
      }
      log(`换新：${oldId}（${steps}/${limit} 步，${reason}）→ ${newId}，工作区「${workspace.title}」`)
    }

    function buildSummary(session, workspace, steps, limit, reason, archive) {
      return summaryText(session, workspace, steps, limit, reason, archive)
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
export { normalizeConfig, sanitizeConfig, configWarnings, workspaceOverrides, clipReply }

