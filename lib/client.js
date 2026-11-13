/**
 * dsh-session-rotate —— 客户端半边
 *
 * 两个职责：
 *   1. 跳转：宿主把「刚换出来的新会话 id」挂在 /dsh-session-rotate/state 上，
 *      这里每 2.5 秒问一次，见到新的 at 就用 uiWorkspace.openSession(id) 把主视图换过去；
 *   2. 设置页：往设置面板的 settings.section 槽注册一页「会话换新」，
 *      读写宿主端点 /dsh-session-rotate/config（宿主把它落到 config.json，保存即生效）。
 *
 * react / react/jsx-runtime 来自 web 外壳的静态模块表，直接 require 即可。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-rotate',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'settings.sessionRotate'

    const zh = {
      nav: '会话换新',
      title: '会话换新（步数上限）',
      intro: '会话步数到上限时自动开新会话、发交接摘要并归档旧会话。下面的值存在 config.json，保存后立即生效，不用重启。',
      defaultLabel: '默认步数上限',
      defaultHint: '只给「已勾选、但步数栏留空」的工作区用。步数栏填了数字的工作区用它自己的数字，这里改多大都不会影响它。',
      workspaces: '按工作区单独设置上限',
      none: '（侧边栏里还没有工作区）',
      hintExact: '勾选才启用；名字要与侧边栏显示名完全一致，对不上就不生效。步数栏留空 = 用上面的默认值。',
      followDefault: '跟随默认',
      defaultEmpty: '默认值必须填一个正整数。',
      emptyWarn: '名单为空 = 所有工作区都不生效。确实要清空，再点一次「保存」。',
      notLoaded: '还没读到配置，先点「重新读取」。',
      sourceFile: '配置来源：config.json（就是这里保存的值）',
      sourcePatch: '配置来源：cordis patch 里的初始配置（还没在这里保存过）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      reload: '重新读取',
      logTitle: '最近日志',
      emptyLog: '（还没有日志）',
      fail: '请求失败：',
      softLimit:
        '上限是软上限：步数只在每轮结束时刷新，插件看不见轮内增长，所以真实换新时的步数会在上限附近浮动——开预判通常略低于上限（早换一轮），关预判往往明显高于上限（一轮能一次跑掉十几步）。别指望它精确等于上限。',
      protectTitle: '保护闸与试运行',
      protectHint: '这几项跟上限一起存在 config.json，保存即生效；以前只能手改文件。',
      minStepsLabel: '最小步数',
      minStepsHint: '累计步数不到这个数时，不论越限还是预判，一律不换（填 0 = 关掉这道闸）。',
      cooldownLabel: '冷却（分钟）',
      cooldownHint: '同一个工作区在这个时间窗内最多换 1 次。',
      maxRotationsLabel: '连续换新上限（次）',
      maxRotationsHint: '在「冷却 × 这个次数」的窗口里换满这么多次，就暂停该工作区，直到重启插件或提交 clearPause。',
      dryRunLabel: '试运行（只记日志不换）',
      dryRunHint: '勾上后到点也不建新会话、不归档，只在日志里写一条 [dry-run] 只记日志不换。',
      archiveLabel: '换新时归档旧会话',
      archiveHint:
        '取消勾选后旧会话会留在侧边栏，请自行定期清理；交接摘要只带状态（目标 / 改动 / 命令 / 未完成），不含上一轮正文。',
      deferArchiveLabel: '归档前先留（分钟）',
      deferArchiveHint:
        '换新后旧会话先不归档，留在侧边栏这么久，够你点开看完最后一条回复，到点自动归档。默认 0 = 换新就归档；上一项取消勾选时这一项不生效。',
      autoSwitchLabel: '换新后自动跳到新会话',
      autoSwitchHint:
        '取消勾选后仍会建新会话、投递交接摘要，但界面停在旧会话不动，新会话只出现在侧边栏。取消勾选时，归档要等「到点自动跳到新会话」把界面切走才敢做。',
      switchOnArchiveLabel: '归档到点时自动跳到新会话',
      switchOnArchiveHint:
        '只在关掉「换新后自动跳到新会话」、并且「归档前先留」大于 0 时出现：到点先把你切到新会话，再归档旧会话，免得你正看着的会话变成「暂时无法查看」。取消勾选则旧会话一律保留、永不归档。',
      pausedWarn: '已因连续换新暂停：',
    }

    const en = {
      nav: 'Session rotation',
      title: 'Session rotation (step limit)',
      intro: 'When a session reaches its step limit, a new session is created, a handoff summary is sent, and the old session is archived. Values are stored in config.json and apply as soon as you save.',
      defaultLabel: 'Default step limit',
      defaultHint: 'Only used by checked workspaces whose step field is left empty. A workspace with its own number uses that number — changing this value will not affect it.',
      workspaces: 'Per-workspace limits',
      none: '(no workspaces yet)',
      hintExact: 'A workspace applies only when checked; the name must match the sidebar name exactly. Empty step field = use the default above.',
      followDefault: 'follows default',
      defaultEmpty: 'The default must be a positive integer.',
      emptyWarn: 'An empty list means no workspace rotates. Click Save again to confirm clearing it.',
      notLoaded: 'Config not loaded yet — click Reload first.',
      sourceFile: 'Source: config.json (the values saved here)',
      sourcePatch: 'Source: initial cordis patch config (nothing saved here yet)',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      reload: 'Reload',
      logTitle: 'Recent log',
      emptyLog: '(no log yet)',
      fail: 'Request failed: ',
      softLimit:
        'The limit is soft: step counts only refresh at the end of a turn, so the plugin cannot see growth mid-turn. The real rotation point therefore drifts around the limit — with prediction on it usually lands slightly below (rotates one turn early), with prediction off it often overshoots badly. Do not expect an exact hit.',
      protectTitle: 'Guard rails & dry run',
      protectHint: 'These live in config.json next to the limit and apply on save; previously they were hand-edited only.',
      minStepsLabel: 'Minimum steps',
      minStepsHint: 'Below this many steps nothing rotates, limit or prediction (0 disables this guard).',
      cooldownLabel: 'Cooldown (minutes)',
      cooldownHint: 'A workspace rotates at most once inside this window.',
      maxRotationsLabel: 'Max rotations in a row',
      maxRotationsHint: 'Rotating this many times inside cooldown × N pauses the workspace until the plugin restarts or clearPause is submitted.',
      dryRunLabel: 'Dry run (log only)',
      dryRunHint: 'When on, nothing is created or archived; the log gets one "[dry-run] log only" line instead.',
      archiveLabel: 'Archive the old session on rotation',
      archiveHint: 'Turn this off and the old session stays in the sidebar — clean it up yourself when you no longer need it. The handoff summary carries state only (goal, files touched, commands run, what is left), not the previous reply.',
      deferArchiveLabel: 'Keep it unarchived for (minutes)',
      deferArchiveHint:
        'On rotation the old session stays unarchived in the sidebar this long, so you can open it and read the last reply; it is archived automatically afterwards. Default 0 = archive immediately. Ignored when the checkbox above is off.',
      autoSwitchLabel: 'Jump to the new session automatically',
      autoSwitchHint:
        'Turn this off and a new session is still created and the handoff still delivered, but the UI stays on the old session — the new one only shows up in the sidebar. While this is off, archiving waits for the "jump when archiving" option to move the UI first.',
      switchOnArchiveLabel: 'Jump to the new session when the archive fires',
      switchOnArchiveHint:
        'Only shown when "jump to the new session" is off and "keep it unarchived" is above 0: at the deadline the UI is moved to the new session first, then the old one is archived — so the session you are reading never turns into "temporarily unavailable". Turn this off and the old session is never archived.',
      pausedWarn: 'Paused after repeated rotations: ',
    }

    const S = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '8px 0',
        fontSize: '13px',
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 16px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      title: { fontSize: '14px', fontWeight: 500 },
      hint: { color: 'var(--dsw-alias-label-tertiary)' },
      num: {
        width: '88px',
        padding: '4px 8px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-bg-skeleton)',
        color: 'inherit',
        fontSize: '13px',
      },
      btn: {
        padding: '6px 14px',
        borderRadius: '10px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        color: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      table: { display: 'flex', flexDirection: 'column', gap: '6px' },
      cell: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      pre: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-skeleton)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        lineHeight: '16px',
        maxHeight: '180px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
    }

    /** 把宿主快照摊成可编辑的行：已有工作区 + 配置里写过但这会儿不在列表里的名字 */
    function toRows(snapshot) {
      /** name → 专值（null = 跟着默认走）；只收名单里出现过的名字 */
      const configured = new Map()
      for (const item of snapshot?.workspaces ?? []) {
        if (!item || typeof item.name !== 'string') continue
        configured.set(item.name, typeof item.override === 'number' ? item.override : null)
      }
      const rows = []
      const seen = new Set()
      for (const item of snapshot?.available ?? []) {
        if (!item || typeof item.name !== 'string' || item.name === '' || seen.has(item.name)) continue
        seen.add(item.name)
        const own = configured.get(item.name)
        rows.push({
          name: item.name,
          path: item.path ?? '',
          on: configured.has(item.name),
          /** 空串 = 留空，跟着默认走；数字 = 该工作区专值 */
          maxSteps: typeof own === 'number' ? String(own) : '',
        })
      }
      for (const [name, own] of configured) {
        if (seen.has(name)) continue
        seen.add(name)
        rows.push({ name, path: '', on: true, maxSteps: typeof own === 'number' ? String(own) : '' })
      }
      return rows
    }

    const URL_CONFIG = '/dsh-session-rotate/config'
    const PENDING_TTL_MS = 120_000

    /** 输入框可能是空串或乱填：给确定的兜底，避免把 NaN / 空值写回配置 */
    function toCount(value, fallback, min) {
      const n = Number(String(value ?? '').trim())
      return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback
    }

    function Panel(props) {
      const t = props.t
      const [snap, setSnap] = React.useState(null)
      const [rows, setRows] = React.useState([])
      const [def, setDef] = React.useState(40)
      /** 保护闸三项 + 试运行开关：宿主快照里都有，这里直接映射成输入框 */
      const [minSteps, setMinSteps] = React.useState(10)
      const [cooldown, setCooldown] = React.useState(10)
      const [maxRotations, setMaxRotations] = React.useState(3)
      const [dryRun, setDryRun] = React.useState(false)
      const [archive, setArchive] = React.useState(true)
      const [deferArchive, setDeferArchive] = React.useState(0)
      /** 换新后是否自动跳转到新会话：关掉就只建会话、不切界面 */
      const [autoSwitch, setAutoSwitch] = React.useState(true)
      /** 界面没跳时，到点归档那一刻是否先把人切到新会话（关掉则旧会话一律保留、永不归档） */
      const [switchOnArchive, setSwitchOnArchive] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      /** 空名单要连点两次才落盘：防「面板没读全就保存」把 workspaces 清空 */
      const [armed, setArmed] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [error, setError] = React.useState('')

      const applySnapshot = React.useCallback((next) => {
        setSnap(next)
        setDef(next?.defaultMaxSteps ?? 40)
        setMinSteps(typeof next?.minSteps === 'number' ? next.minSteps : 10)
        setCooldown(typeof next?.cooldownMinutes === 'number' ? next.cooldownMinutes : 10)
        setMaxRotations(typeof next?.maxRotations === 'number' ? next.maxRotations : 3)
        setDryRun(next?.dryRun === true)
        setArchive(next?.archiveOnRotate !== false)
        setDeferArchive(typeof next?.deferArchiveMinutes === 'number' ? next.deferArchiveMinutes : 0)
        setAutoSwitch(next?.autoSwitch !== false)
        setSwitchOnArchive(next?.switchOnArchive !== false)
        setRows(toRows(next))
        setArmed(false)
      }, [])

      const load = React.useCallback(async () => {
        setError('')
        try {
          const response = await fetch(URL_CONFIG, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          applySnapshot(await response.json())
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [applySnapshot])

      React.useEffect(() => {
        load()
      }, [load])

      const update = (index, patch) => {
        setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
      }

      const save = async () => {
        if (snap === null) {
          setError(t('notLoaded'))
          return
        }
        if (rows.filter((row) => row.on).length === 0 && !armed) {
          setArmed(true)
          setNote(t('emptyWarn'))
          return
        }
        setBusy(true)
        setError('')
        setNote('')
        try {
          const payload = {
            defaultMaxSteps: Number(def) || 0,
            /** 保护闸：必须显式带上，否则宿主按「缺键 = 默认」把它们冲回 10 / 10 / 3 / false */
            minSteps: toCount(minSteps, 10, 0),
            cooldownMinutes: toCount(cooldown, 10, 1),
            maxRotations: toCount(maxRotations, 3, 1),
            dryRun: dryRun === true,
            archiveOnRotate: archive !== false,
            deferArchiveMinutes: toCount(deferArchive, 0, 0),
            /** 换新后是否把界面切到新会话；缺键宿主按 true 处理 */
            autoSwitch: autoSwitch !== false,
            /** 界面没跳时，到点归档前是否先把界面切到新会话；缺键宿主按 true 处理 */
            switchOnArchive: switchOnArchive !== false,
            /** 空名单要显式确认：宿主侧同样会校验 */
            confirmEmpty: armed,
            workspaces: rows
              .filter((row) => row.on)
              .map((row) => {
                const raw = String(row.maxSteps ?? '').trim()
                /** 留空 = null = 跟着默认走，不把默认值写死进来 */
                const own = raw === '' ? null : Number(raw)
                return { name: row.name, maxSteps: Number.isFinite(own) && own > 0 ? own : null }
              }),
          }
          const response = await fetch(URL_CONFIG, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || body?.ok === false) {
            throw new Error(body?.error ?? 'HTTP ' + response.status)
          }
          applySnapshot(body)
          const warnings = Array.isArray(body?.warnings) ? body.warnings : []
          setNote(warnings.length === 0 ? t('saved') : t('saved') + ' ' + warnings.join('；'))
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      const list =
        rows.length === 0
          ? h('div', { style: S.hint }, t('none'))
          : h(
              'div',
              { style: S.table },
              rows.map((row, index) =>
                h(
                  'div',
                  { key: row.name, style: S.row },
                  h('input', {
                    type: 'checkbox',
                    checked: row.on,
                    onChange: (event) => update(index, { on: event.target.checked }),
                  }),
                  h('span', { style: S.cell, title: row.path || row.name }, row.name),
                  h('input', {
                    type: 'number',
                    min: 1,
                    style: S.num,
                    value: row.maxSteps === '' ? '' : String(row.maxSteps),
                    placeholder: String(def),
                    disabled: !row.on,
                    onChange: (event) => update(index, { maxSteps: event.target.value }),
                  }),
                  h('span', { style: S.hint }, row.on ? (row.maxSteps === '' ? t('followDefault') : '') : ''),
                ),
              ),
            )

      /** 一行「标签 + 数字输入 + 说明」：保护闸都用这个形状 */
      const protectRow = (label, hint, value, setter, min) =>
        h(
          'div',
          { key: label, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.cell }, label),
            h('input', {
              type: 'number',
              min,
              style: S.num,
              value: String(value),
              onChange: (event) => setter(event.target.value),
            }),
          ),
          h('div', { style: S.hint }, hint),
        )

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.title }, t('title')),
        h('div', { style: S.hint }, t('intro')),
        h('div', { style: S.hint }, t('softLimit')),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.cell }, t('defaultLabel')),
            h('input', {
              type: 'number',
              min: 1,
              style: S.num,
              value: String(def),
              onChange: (event) => setDef(event.target.value),
            }),
          ),
          h('div', { style: S.hint }, t('defaultHint')),
          h('div', { style: S.hint }, snap === null ? '' : snap.source === 'file' ? t('sourceFile') : t('sourcePatch')),
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.cell }, t('workspaces')),
            h('span', { style: S.hint }, t('hintExact')),
          ),
          list,
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.cell }, t('protectTitle')),
            h('span', { style: { ...S.hint, textAlign: 'right' } }, t('protectHint')),
          ),
          protectRow(t('minStepsLabel'), t('minStepsHint'), minSteps, setMinSteps, 0),
          protectRow(t('cooldownLabel'), t('cooldownHint'), cooldown, setCooldown, 1),
          protectRow(t('maxRotationsLabel'), t('maxRotationsHint'), maxRotations, setMaxRotations, 1),
          h(
            'div',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: dryRun,
              onChange: (event) => setDryRun(event.target.checked),
            }),
            h('span', { style: S.cell }, t('dryRunLabel')),
          ),
          h('div', { style: S.hint }, t('dryRunHint')),
          h(
            'div',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: archive,
              onChange: (event) => setArchive(event.target.checked),
            }),
            h('span', { style: S.cell }, t('archiveLabel')),
          ),
          h('div', { style: S.hint }, t('archiveHint')),
          archive
            ? protectRow(t('deferArchiveLabel'), t('deferArchiveHint'), deferArchive, setDeferArchive, 0)
            : null,
          h(
            'div',
            { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: autoSwitch,
              onChange: (event) => setAutoSwitch(event.target.checked),
            }),
            h('span', { style: S.cell }, t('autoSwitchLabel')),
          ),
          h('div', { style: S.hint }, t('autoSwitchHint')),
          /** 只在「换新不跳转」且留了回看窗口（保留期 > 0）时才有意义：没有「到点」这回事的开关是空的 */
          autoSwitch || !(deferArchive > 0)
            ? null
            : h(
                'div',
                { style: S.row },
                h('input', {
                  type: 'checkbox',
                  checked: switchOnArchive,
                  onChange: (event) => setSwitchOnArchive(event.target.checked),
                }),
                h('span', { style: S.cell }, t('switchOnArchiveLabel')),
              ),
          autoSwitch || !(deferArchive > 0)
            ? null
            : h('div', { style: S.hint }, t('switchOnArchiveHint')),
          snap?.paused?.length
            ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-label-warning, #c33)' } }, t('pausedWarn') + snap.paused.join('、'))
            : null,
        ),
        h(
          'div',
          { style: S.row },
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: load }, t('reload')),
          note === '' ? null : h('span', { style: S.hint }, note),
          error === '' ? null : h('span', { style: { color: 'var(--dsw-alias-label-warning, #c33)' } }, t('fail') + error),
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.cell }, t('logTitle')),
            h('span', { style: S.hint }, snap?.configFile ?? ''),
          ),
          h('pre', { style: S.pre }, snap?.log ? snap.log : t('emptyLog')),
        ),
      )
    }

    return {
      name: 'dsh-session-rotate/client',
      inject: ['uiWorkspace', 'slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-rotate: dictionaries')

        // ---- 设置页 ----
        try {
          ctx.effect(
            () =>
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: 'session-rotate',
                    order: 30,
                    label: () => t('nav'),
                    locale: NS,
                    inject: () => ({ t }),
                  },
                  Panel,
                ),
              ),
            'session-rotate: settings section',
          )
        } catch (error) {
          console.warn('[session-rotate] 设置页注册失败:', error?.message ?? error)
        }

        // ---- 换新后自动跳转 ----
        let applied = null
        let stopped = false

        async function poll() {
          if (stopped) return
          try {
            const response = await fetch('/dsh-session-rotate/state', {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const body = await response.json()
            const pending = body?.pending
            if (!pending || typeof pending.sessionId !== 'string') return
            // 只认刚发生的换新：宿主不会清 pending，太旧的一跳就会把人送回几天前那个会话
            if (typeof pending.at !== 'number' || Date.now() - pending.at > PENDING_TTL_MS) return
            // 这一跳要不要真跳由服务端逐次决定：换新（rotate）看 autoSwitch，到点归档（archive）看 switchOnArchive
            const wantSwitch =
              typeof pending.switch === 'boolean' ? pending.switch : body?.autoSwitch !== false
            if (applied === pending.at) return
            // 无论跳不跳都记下这一跳，免得之后打开开关又把这次旧 pending 补跳一遍
            applied = pending.at
            if (!wantSwitch) return
            // 到点归档那一跳：只有人正看着被归档的那个会话时才动他，人在看别的会话就不打扰
            if (pending.reason === 'archive' && typeof pending.from === 'string') {
              let current = ''
              try {
                current = ctx.uiWorkspace?.mainReference?.sessionId ?? ''
              } catch {
                current = ''
              }
              if (typeof current === 'string' && current !== '' && current !== pending.from) return
            }
            try {
              ctx.uiWorkspace.openSession(pending.sessionId)
            } catch (error) {
              console.warn('[session-rotate] 跳转失败:', error?.message ?? error)
            }
          } catch {
            /* 宿主没起来或路由缺失：静默重试 */
          }
        }

        const timer = setInterval(poll, 2500)
        poll()
        ctx.on('dispose', () => {
          stopped = true
          clearInterval(timer)
        })
      },
    }
  },
})
