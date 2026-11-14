// dsh-improve-think —— Client 半（Web UI）
//
// 形态沿用已安装双半插件的约定：window.__ModuleLoader__.load({ id, factory })，
// factory 返回 { apply, inject }。id 必须等于包名。
//
// 数据流：
//   Host 投影 dshImproveThink（wire.view）→ slot props 的 useProjection('dshImproveThink') → 本组件渲染
//   点击 → ctx.remote.commands.execute(sessionId, '/improve ...') → Host 改状态 → 投影推送 → 重渲染
//
// 注意：已安装 npm 包没有 host.call（那是动态双半包沙箱才有的能力），
// 因此写回一律走 session command。

window.__ModuleLoader__.load({
  id: 'dsh-improve-think',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-improve-think'
    const PROJECTION_KEY = 'dshImproveThink'

    const zh = {
      label: '档位',
      tier: '思考档',
      adversarial: '对抗',
      idleGuard: '空转守护',
      firstTurnFast: '首轮快跳',
      on: '开',
      off: '关',
      tiers: { normal: '常规', strict: '严格', extreme: '极致' },
      idle: '疑似空转',
      degraded: '无流内打断',
      error: '操作失败',
      noSession: '会话尚未就绪',
      noChannel: '宿主没有暴露会话命令通道（sessions/remote 均不可用）',
      hint: {
        tier: '思考档是行为规范档，不改推理强度',
        adversarial: '对抗审查：反例、代价、偏离检查',
        idleGuard: '只拦反复无进展，不拦深度思考',
        firstTurnFast: '首轮先给可执行计划，后续仍可深想',
        reset: '把本会话改过的项恢复成插件页默认值',
      },
      settings: {
        title: '档位与守护设置',
        subtitle: '这里保存的是全局默认值，重启后仍在；当前会话如果没有单独改过某项，就会实时跟随这里的值。',
        defaults: '思考档默认值',
        toggles: '默认开关',
        guard: '空转守护参数',
        stagnation: '停滞轮数阈值',
        similarity: '推理尾部相似度',
        interval: '目标对照间隔（轮）',
        minChars: '最短判定推理字数',
        maxInterrupts: '每步最多中断次数',
        action: '检测到空转时',
        observe: '只记录（observe）',
        interrupt: '流内中断（interrupt）',
        saved: '已保存',
        saving: '保存中…',
        failed: '保存失败，请重试',
        readonly: '当前配置只读（Host 未开放写入）',
        unavailable: 'Host 还没有暴露本插件的配置（重新安装或重启 DSH 后再试）',
        restore: '全部恢复默认',
        restored: '已恢复默认',
        summaryHint: '（在插件详情页调整）',
      },
    }

    const en = {
      label: 'Modes',
      tier: 'Thinking',
      adversarial: 'Adversarial',
      idleGuard: 'Idle guard',
      firstTurnFast: 'Fast start',
      on: 'on',
      off: 'off',
      tiers: { normal: 'Normal', strict: 'Strict', extreme: 'Extreme' },
      idle: 'Possible idle loop',
      degraded: 'No in-stream interrupt',
      error: 'Action failed',
      noSession: 'Session not ready',
      noChannel: 'No session-command channel exposed (sessions/remote unavailable)',
      hint: {
        tier: 'A behaviour mode, not a reasoning-effort switch',
        adversarial: 'Counter-examples, cost, goal-drift review',
        idleGuard: 'Blocks repeated no-progress only, never deep thinking',
        firstTurnFast: 'Plan first, deep work still allowed later',
        reset: 'Restore overridden fields in this session back to plugin defaults',
      },
      settings: {
        title: 'Modes and guard settings',
        subtitle: 'These are global defaults, kept across restarts. A session that has not overridden a field follows them live.',
        defaults: 'Default mode',
        toggles: 'Default switches',
        guard: 'Idle guard parameters',
        stagnation: 'Stagnant turns before judging',
        similarity: 'Reasoning-tail similarity',
        interval: 'Goal-check interval (turns)',
        minChars: 'Minimum reasoning characters',
        maxInterrupts: 'Max interrupts per step',
        action: 'When idle is detected',
        observe: 'Observe only',
        interrupt: 'Interrupt in stream',
        saved: 'Saved',
        saving: 'Saving…',
        failed: 'Save failed, please retry',
        readonly: 'Configuration is read-only (Host denies writes)',
        unavailable: 'Host does not expose this plugin config yet (reinstall or restart DSH)',
        restore: 'Restore all defaults',
        restored: 'Defaults restored',
        summaryHint: '(edit on the plugin page)',
      },
    }

    const TIERS = ['normal', 'strict', 'extreme']

    // 样式全部走 ctx.styles.insert 注入一次，作用域限定在 [data-dsh-improve-think]，
    // 类名前缀 dit-（官方要求：动态插件用 CSS 变量而不是硬编码颜色，且不要 import 第一方组件）。
    // 之所以不用 inline style：hover / focus-visible / 深色模式覆盖都写不出来。
    //
    // 尺寸照抄原生控件：
    // - 输入框上方的全宽条 → QueueDock 的 attached panel（0.5px border-l1、上圆角、贴卡片上沿）
    // - 条内控件 → StatsPills 的 pill（13px-1、label-tertiary、transparent 底、hover 有 bg）
    const CLIENT_CSS = `
[data-dsh-improve-think] { box-sizing: border-box; }
[data-dsh-improve-think] .dit-band {
  width: 100%; margin: 0 auto; padding: 2px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28));
  border-bottom: 0; border-radius: var(--dsw-radius-md, 12px) var(--dsw-radius-md, 12px) 0 0;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06));
  color: var(--dsw-alias-label-tertiary, #8b8b8b);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 20px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  flex-wrap: wrap; min-height: 26px; user-select: none;
}
[data-dsh-improve-think] .dit-seg { display: inline-flex; align-items: center; gap: 1px; }
[data-dsh-improve-think] .dit-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 1px 8px; border: 0; border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; color: inherit; font: inherit; cursor: pointer;
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
[data-dsh-improve-think] .dit-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); color: var(--dsw-alias-label-secondary, #b4b4b4); }
[data-dsh-improve-think] .dit-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe)); }
[data-dsh-improve-think] .dit-btn[disabled] { opacity: .55; cursor: default; }
[data-dsh-improve-think] .dit-btn[data-active='true'] { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1)); }
[data-dsh-improve-think] .dit-btn[data-active='true'] .dit-dot { box-shadow: none; background: var(--dsw-alias-brand-primary, #4d6bfe); }
[data-dsh-improve-think] .dit-dot {
  width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%;
  background: transparent; box-shadow: inset 0 0 0 1px currentColor;
}
[data-dsh-improve-think] .dit-sep { width: 0.5px; height: 12px; background: var(--dsw-alias-border-l2, rgba(127,127,127,0.3)); margin: 0 4px; }
[data-dsh-improve-think] .dit-tag { padding: 0 2px; white-space: nowrap; }
[data-dsh-improve-think] .dit-tag[data-kind='warn'] { color: var(--dsw-alias-state-warning, #d98b0b); }
[data-dsh-improve-think] .dit-tag[data-kind='error'] { color: var(--dsw-alias-state-danger, #e5544b); }
[data-dsh-improve-think] .dit-sub { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #8b8b8b); }
[data-dsh-improve-think] .dit-group { margin: 6px 0 0; font-size: 13px; font-weight: 500; line-height: 22px; color: var(--dsw-alias-label-secondary, #b4b4b4); }
[data-dsh-improve-think] .dit-field { display: flex; flex-direction: column; gap: 6px; }
[data-dsh-improve-think] .dit-field > span { font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); }
[data-dsh-improve-think] .dit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 16px; margin-top: 4px; }
[data-dsh-improve-think] .dit-input {
  min-height: 32px; padding: 0 8px; font: inherit; font-size: 13px;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.4));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary, #e6e6e6);
}
[data-dsh-improve-think] .dit-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, #4d6bfe); }
[data-dsh-improve-think] .dit-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
[data-dsh-improve-think] .dit-btn-solid {
  min-height: 28px; padding: 0 12px; font: inherit; font-size: 13px; cursor: pointer;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.4));
  border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, #b4b4b4);
}
[data-dsh-improve-think] .dit-btn-solid:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
[data-dsh-improve-think] .dit-btn-solid[disabled] { opacity: .55; cursor: default; }
[data-dsh-improve-think] .dit-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8b8b8b); }
[data-dsh-improve-think] .dit-summary strong { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; }
`

    // ctx.styles 不可用时的最小可用外观（只在样式表注入失败的宿主上生效）。
    const BAND_FALLBACK = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexWrap: 'wrap',
      gap: '6px',
      minHeight: '26px',
      padding: '2px 10px',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-improve-think: dictionaries')
      const t = ctx.locale.bind(NS)

      const safeGet = (name) => {
        try {
          return ctx.get?.(name) ?? undefined
        } catch {
          return undefined
        }
      }
      const safeCall = (fn) => {
        try {
          return fn()
        } catch {
          return undefined
        }
      }

      // 宿主 cordis 的 inject 只认**字符串数组**：它把声明折成 `{ 服务名: 拦截器 }` 的 map，
      // 每个 key 都是它要等的服务。写成 `{ required: [...], optional: [...] }` 时会被折成
      // 两个叫 "required" / "optional" 的服务 → 永远等不到 → 条目一直 pending →
      // web boot 判定 "N entries did not activate" 并整页报错（v0.2.1 启动崩溃的根因）。
      // 所以把实际用到的服务平铺声明在数组里；个别服务读不到时由调用点 try/catch 降级。
      const readService = (name) => {
        try {
          const direct = ctx[name]
          if (direct !== undefined) return direct
        } catch {
          /* guard 拒绝未声明服务时走下面的兜底 */
        }
        return safeGet(name)
      }

      // 稳定的 observable 源：包住 ConfigFormController（插件页设置表单），
      // 档位条与设置面板共用同一个源，这样插件页一保存，档位条立刻反映新默认值。
      const settingsSource = createSettingsSource()

      function createSettingsSource() {
        let form = null
        let off = null
        const listeners = new Set()
        const notify = () => {
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              /* 单个订阅者出错不影响其它订阅者 */
            }
          }
        }
        const attach = (next) => {
          if (next === form) return
          try {
            off?.()
          } catch {
            /* 旧控制器的退订失败可以忽略 */
          }
          off = null
          form = next ?? null
          if (form && typeof form.subscribe === 'function') {
            try {
              off = form.subscribe(notify)
            } catch {
              off = null
            }
          }
          notify()
        }
        return {
          attach,
          current: () => form,
          getSnapshot: () =>
            form && typeof form.getSnapshot === 'function'
              ? form.getSnapshot()
              : { status: 'unavailable', writable: false, value: {} },
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        }
      }

      // 写回 Host：官方通道是 `ctx.remote.commands.execute`。
      //
      // 两条硬性要求（都踩过坑）：
      // 1) 必须声明 `'remote.commands'`，只声明 `'remote'` 不够——cordis 把每个 remote
      //    命名空间注册成独立服务 `remote.<namespace>`，读 `ctx.remote.commands` 这一瞬
      //    就抛 `cannot get property "remote.commands" without inject`，try/catch 也救不回。
      // 2) 不要赌 `sessions.binding(id)` 有值：它只在会话被 retain 过时才存在，而且
      //    `ISession.command` 只是同一底层，还会把 result.kind/text 丢掉。所以先用
      //    remote.commands，ISession.command 只作旧宿主兜底。
      const runCommand = async (sessionId, line) => {
        const remote = safeCall(() => ctx.remote)
        const execute = remote?.commands?.execute
        if (typeof execute === 'function') {
          const result = await execute.call(remote.commands, sessionId, line, [])
          if (!result || result.ok !== true) {
            const detail = result?.error?.message ?? result?.error?.code ?? 'command failed'
            throw new Error(String(detail))
          }
          // value === undefined 表示"命令不存在/语法错"：Host 根本没进 handler。
          if (result.value === undefined) throw new Error(`Host 没有注册 /improve 命令：${line}`)
          const outcome = result.value?.result
          if (outcome?.kind === 'error') throw new Error(String(outcome.text ?? 'command failed'))
          // 命令执行成功后立刻刷新投影，让 overrides 与档位条对齐。
          safeCall(() => readService('sessions')?.refreshProjections?.(sessionId))
          return result
        }
        // 兜底：极老的宿主没有 remote 命名空间时，退回会话命令。
        const binding = safeCall(() => readService('sessions')?.binding?.(sessionId))
        const sessionCommand = binding?.session?.command
        if (typeof sessionCommand !== 'function') throw new Error(t('noChannel'))
        const fallback = await sessionCommand.call(binding.session, line)
        if (!fallback || fallback.ok !== true) {
          throw new Error(String(fallback?.error?.message ?? 'command failed'))
        }
        if (fallback.value?.matched === false) throw new Error(`Host 没有注册 /improve 命令：${line}`)
        safeCall(() => readService('sessions')?.refreshProjections?.(sessionId))
        return fallback
      }

      const tierBar = () => (props) => {
        const sessionId = props?.sessionId
        const useProjection = props?.useProjection
        // useProjection 是 slot prop（Hook）；旧宿主可能不给，条件调用是稳定的（每次渲染同条件）。
        const projected =
          typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
        const [local, setLocal] = React.useState(undefined)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')
        // 插件页设置的实时快照：保存后立刻同步给档位条（provider 只推 session projection，
        // 不会因为改了插件配置而推送，所以这里自己订阅一次）。
        const [settingsSnap, setSettingsSnap] = React.useState(undefined)

        React.useEffect(() => {
          const read = () => setSettingsSnap(settingsSource.getSnapshot())
          read()
          return settingsSource.subscribe(read)
        }, [])

        // 点击后先乐观更新；投影/设置快照任一带来新值就丢弃乐观值。
        React.useEffect(() => {
          if (projected !== undefined) setLocal(undefined)
        }, [projected])

        const overrides = projected?.overrides ?? {}
        const overrideKeys = Array.isArray(projected?.overrideKeys)
          ? projected.overrideKeys
          : Object.keys(overrides)
        // Host 新投影把「默认值」与「本会话覆盖」分开给；旧投影只给生效值。
        // 分开时：默认值优先取插件页实时值（用户刚保存的），再叠上本会话覆盖与乐观值。
        const hasSplit = projected !== undefined && (projected.defaults !== undefined || projected.overrides !== undefined)
        const base = hasSplit ? (settingsSnap?.value ?? projected?.defaults ?? {}) : (projected ?? {})
        const merged = { ...base, ...(hasSplit ? overrides : {}), ...(local ?? {}) }
        const tier = TIERS.includes(merged.tier) ? merged.tier : 'normal'
        const adversarial = merged.adversarial === true
        const idleGuard = merged.idleGuard !== false
        const firstTurnFast = merged.firstTurnFast !== false
        const marked = projected?.marked === true
        const degraded = projected?.capabilities?.streamIntercept === false

        const send = (args, optimistic) => {
          if (!sessionId) {
            setError(t('noSession'))
            return
          }
          // slot 的 `inject(sessionId)` 会把绑定好 sessionId 的 runCommand 传进来；
          // 没有时退回自己拼一条（两条路都走 ctx.remote.commands）。
          const runner = typeof props?.runCommand === 'function' ? props.runCommand : (line) => runCommand(sessionId, line)
          if (optimistic) setLocal({ ...(local ?? {}), ...optimistic })
          setBusy(true)
          setError('')
          Promise.resolve()
            .then(() => runner(`/improve ${args}`))
            .catch((failure) => {
              // 失败就回退乐观更新，并显示错误（绝不把异常抛进 React 事件）。
              setLocal(undefined)
              setError(`${t('error')}: ${failure?.message ?? failure}`)
            })
            .finally(() => setBusy(false))
        }

        const controls = [
          h(
            'span',
            { key: 'tier', className: 'dit-seg', title: t('hint.tier') },
            ...TIERS.map((id) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  className: 'dit-btn',
                  'data-active': tier === id ? 'true' : 'false',
                  disabled: busy,
                  'aria-pressed': tier === id,
                  title: t(`hint.tier`),
                  onClick: () => send(`tier ${id}`, { tier: id }),
                },
                t(`tiers.${id}`),
              ),
            ),
          ),
          h('span', { key: 'divider', className: 'dit-sep', 'aria-hidden': 'true' }),
          h(
            'button',
            {
              key: 'adversarial',
              type: 'button',
              className: 'dit-btn',
              'data-active': adversarial ? 'true' : 'false',
              disabled: busy,
              'aria-pressed': adversarial,
              title: t('hint.adversarial'),
              onClick: () => send(`adversarial ${adversarial ? 'off' : 'on'}`, { adversarial: !adversarial }),
            },
            h('span', { className: 'dit-dot', 'aria-hidden': 'true' }),
            t('adversarial'),
          ),
          h(
            'button',
            {
              key: 'idleGuard',
              type: 'button',
              className: 'dit-btn',
              'data-active': idleGuard ? 'true' : 'false',
              disabled: busy,
              'aria-pressed': idleGuard,
              title: t('hint.idleGuard'),
              onClick: () => send(`idleGuard ${idleGuard ? 'off' : 'on'}`, { idleGuard: !idleGuard }),
            },
            h('span', { className: 'dit-dot', 'aria-hidden': 'true' }),
            t('idleGuard'),
          ),
          h(
            'button',
            {
              key: 'firstTurnFast',
              type: 'button',
              className: 'dit-btn',
              'data-active': firstTurnFast ? 'true' : 'false',
              disabled: busy,
              'aria-pressed': firstTurnFast,
              title: t('hint.firstTurnFast'),
              onClick: () => send(`firstTurnFast ${firstTurnFast ? 'off' : 'on'}`, { firstTurnFast: !firstTurnFast }),
            },
            h('span', { className: 'dit-dot', 'aria-hidden': 'true' }),
            t('firstTurnFast'),
          ),
        ]

        if (overrideKeys.length) {
          controls.push(
            h('span', { key: 'divider-2', className: 'dit-sep', 'aria-hidden': 'true' }),
            h(
              'button',
              {
                key: 'reset',
                type: 'button',
                className: 'dit-btn',
                disabled: busy,
                title: t('hint.reset'),
                onClick: () => send('reset', {}),
              },
              '⟲',
              h('span', { className: 'dit-tag' }, `${overrideKeys.length}`),
            ),
          )
        }

        if (marked) {
          controls.push(
            h('span', {
              key: 'marked',
              className: 'dit-sep',
              'aria-hidden': 'true',
            }),
            h(
              'span',
              { key: 'marked-label', className: 'dit-tag', 'data-kind': 'warn', title: String(projected?.markReason ?? '') },
              `⚠ ${t('idle')}`,
            ),
          )
        }

        if (degraded) {
          controls.push(
            h(
              'span',
              { key: 'degraded', className: 'dit-tag', title: String(projected?.capabilities?.note ?? '') },
              t('degraded'),
            ),
          )
        }

        if (error) {
          controls.push(h('span', { key: 'error', className: 'dit-tag', 'data-kind': 'error' }, error))
        }

        // 样式表注入失败时（老宿主没有 ctx.styles）也用一份最小 inline 兜底，
        // 至少保证"一条能点的一行"，而不是散落的裸文字。
        return h(
          'div',
          {
            className: 'dit-band',
            style: hasCss ? undefined : BAND_FALLBACK,
            'data-dsh-improve-think': 'bar',
          },
          ...controls,
        )
      }

      // ---- 插件页设置面板 ----------------------------------------------------
      // DSH「插件」页 → dsh-improve-think → 配置。
      // 读的是 ctx.configForms（Host `settings` 服务的客户端面），写入走
      // form.set/unset（内部 remote.settings.mutate），不需要自己 inject remote.settings。
      // 用 whileServed 只在 Host 真的服务这个 namespace 时注册，避免出现空白面板。
      const SETTINGS_ENTRY_ID = 'include:dsh-improve-think'
      const SETTINGS_SWITCHES = ['adversarial', 'idleGuard', 'firstTurnFast']
      const SETTINGS_NUMBERS = [
        'stagnationCount',
        'reasoningSimilarityThreshold',
        'goalCheckInterval',
        'minReasoningChars',
        'maxInterruptsPerStep',
      ]
      const SETTINGS_ALL = ['tier', ...SETTINGS_SWITCHES, 'idleGuardAction', ...SETTINGS_NUMBERS]

      // 面板样式走 CLIENT_CSS 里的 .dit-*（与原生设置页同规格：13px 标签、32px 输入、12px 圆角）。
      // 只剩状态文案需要的常量，避免 inline style 阻碍 hover / 深色模式。
      const pageStyle = { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '760px' }


      function settingsPanel() {
        return function DshImproveThinkSettings(props) {
          const { useSettings, saveField, resetAll } = props
          // 同一个组件会被渲染两次：插件列表里的摘要（view='summary'）与插件详情页（view='page'）。
          // 摘要里塞满输入框会把列表撑爆，所以只给一行现状 + 一句去哪儿改。
          const summaryOnly = props?.view === 'summary'
          const snapshot = useSettings ? useSettings((value) => value) : undefined
          const [typed, setTyped] = React.useState({})
          const [status, setStatus] = React.useState('')

          const view = snapshot?.value ?? {}
          const ready = snapshot?.status === 'ready'
          const writable = ready && snapshot?.writable !== false

          const commit = async (field, next) => {
            if (!writable) {
              setStatus(t('settings.readonly'))
              return
            }
            setStatus(t('settings.saving'))
            let ok = false
            try {
              ok = await saveField(field, next)
            } catch {
              ok = false
            }
            setStatus(ok ? t('settings.saved') : t('settings.failed'))
          }

          const commitNumber = (field) => {
            const raw = typed[field]
            if (raw === undefined) return
            const num = Number(raw)
            setTyped((prev) => {
              const next = { ...prev }
              delete next[field]
              return next
            })
            if (!Number.isFinite(num)) {
              setStatus(t('settings.failed'))
              return
            }
            commit(field, num)
          }

          // 三种兜底态共用一个极简外壳：详情页已经有外框，这里只补一行说明。
          const fallback = (text) =>
            h(
              'div',
              { className: 'dit-sub', 'data-dsh-improve-think': 'settings' },
              h('strong', null, t('settings.title')),
              ' ',
              text,
            )

          if (!snapshot || snapshot.status === 'loading') return fallback('…')

          if (!ready) return fallback(t('settings.unavailable'))

          if (summaryOnly) {
            const onOff = (flag) => (flag === true ? t('on') : t('off'))
            return h(
              'div',
              { className: 'dit-summary', 'data-dsh-improve-think': 'settings' },
              h('strong', null, t('settings.title')),
              h('span', null, `${t('tier')} ${t(`tiers.${view.tier ?? 'normal'}`)}`),
              h('span', null, '·'),
              h('span', null, `${t('adversarial')} ${onOff(view.adversarial)}`),
              h('span', null, '·'),
              h('span', null, `${t('idleGuard')} ${onOff(view.idleGuard)}`),
              h('span', null, '·'),
              h('span', null, `${t('firstTurnFast')} ${onOff(view.firstTurnFast)}`),
              h('span', null, t('settings.summaryHint')),
            )
          }

          const numberField = (field, label, format) =>
            h(
              'label',
              { key: field, className: 'dit-field' },
              h('span', null, label),
              h('input', {
                type: 'text',
                inputMode: 'decimal',
                className: 'dit-input',
                disabled: !writable,
                value: typed[field] ?? format(view[field]),
                onChange: (event) => setTyped((prev) => ({ ...prev, [field]: event.target.value })),
                onBlur: () => commitNumber(field),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') commitNumber(field)
                  if (event.key === 'Escape') setTyped((prev) => {
                    const next = { ...prev }
                    delete next[field]
                    return next
                  })
                },
              }),
            )

          const toggle = (field, label) =>
            h(
              'button',
              {
                key: field,
                type: 'button',
                disabled: !writable,
                className: 'dit-btn',
                'data-active': view[field] === true ? 'true' : 'false',
                title: t(`hint.${field}`),
                onClick: () => commit(field, view[field] !== true),
              },
              h('span', { className: 'dit-dot', 'aria-hidden': 'true' }),
              `${label} ${view[field] === true ? t('on') : t('off')}`,
            )

          const tierButton = (tier) =>
            h(
              'button',
              {
                key: tier,
                type: 'button',
                disabled: !writable,
                className: 'dit-btn',
                'data-active': view.tier === tier ? 'true' : 'false',
                onClick: () => commit('tier', tier),
              },
              t(`tiers.${tier}`),
            )

          const actionChip = (action, label) =>
            h(
              'button',
              {
                key: action,
                type: 'button',
                disabled: !writable,
                className: 'dit-btn',
                'data-active': view.idleGuardAction === action ? 'true' : 'false',
                onClick: () => commit('idleGuardAction', action),
              },
              label,
            )

          return h(
            'div',
            { style: pageStyle, 'data-dsh-improve-think': 'settings' },
            h('p', { className: 'dit-sub' }, t('settings.subtitle')),

            h('p', { className: 'dit-group' }, t('settings.defaults')),
            h('div', { className: 'dit-seg' }, ...TIERS.map(tierButton)),

            h('p', { className: 'dit-group' }, t('settings.toggles')),
            h('div', { className: 'dit-seg' }, ...SETTINGS_SWITCHES.map((field) => toggle(field, t(field)))),

            h('p', { className: 'dit-group' }, t('settings.guard')),
            h(
              'div',
              { className: 'dit-seg' },
              actionChip('observe', t('settings.observe')),
              actionChip('interrupt', t('settings.interrupt')),
            ),
            // 五个数值字段排成自适应网格，避免插件页被拉成一长条。
            h(
              'div',
              { className: 'dit-grid' },
              numberField('stagnationCount', t('settings.stagnation'), (v) => String(v ?? '')),
              numberField('reasoningSimilarityThreshold', t('settings.similarity'), (v) => (typeof v === 'number' ? v.toFixed(2) : '')),
              numberField('goalCheckInterval', t('settings.interval'), (v) => String(v ?? '')),
              numberField('minReasoningChars', t('settings.minChars'), (v) => String(v ?? '')),
              numberField('maxInterruptsPerStep', t('settings.maxInterrupts'), (v) => String(v ?? '')),
            ),

            h(
              'div',
              { className: 'dit-foot' },
              h('span', { className: 'dit-sub' }, status),
              h(
                'button',
                {
                  type: 'button',
                  disabled: !writable,
                  className: 'dit-btn-solid',
                  onClick: async () => {
                    setStatus(t('settings.saving'))
                    let ok = false
                    try {
                      ok = await resetAll()
                    } catch {
                      ok = false
                    }
                    setTyped({})
                    setStatus(ok ? t('settings.restored') : t('settings.failed'))
                  },
                },
                t('settings.restore'),
              ),
            ),
          )
        }
      }

      // 样式表只注入一次，随插件卸载一起移除（官方推荐通道，不要 import 第一方组件）。
      // 注意：`ctx.styles` 是受限 facade 上的属性读取，未声明 inject 时会**直接抛错**，
      // 不能用 `if (ctx.styles && …)` 这种裸读——必须走 safeCall 兜住（否则 apply 抛错，
      // 整个插件在启动阶段失败，页面又变成 "Failed to load plugins"）。
      const styles = safeCall(() => ctx.styles) ?? safeGet('styles')
      const hasCss = Boolean(styles && typeof styles.insert === 'function')
      if (hasCss) {
        ctx.effect(() => styles.insert(CLIENT_CSS), 'dsh-improve-think: styles')
      }

      // 「输入框上方一条轻量档位条」→ conversation.input.dock：
      // 这是卡片**上方**的全宽一行（原生 QueueDock 的位置），而 composer.dock 是卡片
      // 下方那两个居中灰色小 pill 的行——把分段控件塞那里会显得既不是输入框的一部分
      // 也不像统计信息，这正是之前"位置奇怪"的原因。
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'dsh-improve-think',
                order: 30,
                label: () => t('label'),
                locale: NS,
                // scope:'session' 的 slot 会把 sessionId 交给 inject()，借它把命令通道
                // 绑到这个会话上——组件里就不用自己猜 sessionId 从哪来。
                inject: (sessionId) => ({ runCommand: (line) => runCommand(sessionId, line) }),
              },
              tierBar(),
            ),
          ),
        'dsh-improve-think: mode bar',
      )

      // 设置面板整段隔离：宿主版差异（configForms 缺失、slot 不认 key、控制器形态不同）
      // 只允许影响"插件页设置"，不允许把档位条和 web boot 一起带走。
      try {
        mountSettingsPanel()
      } catch (error) {
        console.error('[dsh-improve-think] 设置面板挂载失败，已跳过（档位条不受影响）', error)
      }

      function mountSettingsPanel() {
      // Host 暴露的 settings namespace 就是 Loader 条目 id。实测本机 profile 里它是包名
      // （settings.describe() 返回 ns:"dsh-improve-think"），但另一些布局是 `include:<包名>`，
      // 所以两个候选都试，取 Host 实际服务的那一个（包名优先）。
      const SETTINGS_NAMESPACE_CANDIDATES = ['dsh-improve-think', SETTINGS_ENTRY_ID]

      function pickNamespace(served) {
        const list = served instanceof Set ? [...served] : Array.isArray(served) ? served : []
        return SETTINGS_NAMESPACE_CANDIDATES.find((ns) => list.includes(ns)) ?? null
      }

      const configForms = readService('configForms')

      // 面板始终注册（插件页永远能看到"设置"区块），表单控制器则先拿默认 namespace 的，
      // 等 whileServed 报告 Host 真正服务哪个 namespace 再热切过去。
      // settingsSource 在 apply 里创建，档位条与设置面板共用同一个源。
      if (configForms && typeof configForms.get === 'function') {
        const initialForm = safeCall(() => configForms.get(SETTINGS_NAMESPACE_CANDIDATES[0]))
        if (initialForm) settingsSource.attach(initialForm)
      }

      const saveField = (field, value) => {
        const form = settingsSource.current()
        if (!form || typeof form.set !== 'function') throw new Error(t('settings.unavailable'))
        return form.set(field, value)
      }

      const resetAll = async () => {
        const form = settingsSource.current()
        if (!form || typeof form.unset !== 'function') throw new Error(t('settings.unavailable'))
        for (const field of SETTINGS_ALL) {
          const ok = await form.unset(field)
          if (ok === false) return false
        }
        return true
      }

      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: 'dsh-improve-think',
                locale: NS,
                inject: () => ({
                  hooks: { settings: settingsSource },
                  saveField,
                  resetAll,
                }),
              },
              settingsPanel(),
            ),
          ),
        'dsh-improve-think: settings panel',
      )

      if (configForms && typeof configForms.whileServed === 'function') {
        ctx.effect(
          () =>
            configForms.whileServed(SETTINGS_NAMESPACE_CANDIDATES, (served) => {
              const namespace = pickNamespace(served)
              if (namespace === null) return () => {}
              const form = safeCall(() => configForms.get(namespace))
              if (form) settingsSource.attach(form)
              return () => {}
            }),
          'dsh-improve-think: settings namespace',
        )
      }
      }
    }

    // 必须是字符串数组（见上：对象形态会让整个 client 半永远 pending，整页启动报错）。
    // `remote` 是命名空间外壳，`remote.commands` 是独立注册的服务 id——**两个都要声明**，
    // 少一个就会在读取 `ctx.remote.commands` 的那一瞬被 cordis 的 getter 守卫抛错。
    const inject = ['slots', 'locale', 'sessions', 'configForms', 'remote', 'remote.commands']

    return { apply, inject }
  },
})
