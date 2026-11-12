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
      },
      settings: {
        title: '档位与守护设置',
        subtitle: '这里保存的是**新会话的默认值**，写入 profile 配置，重启后仍在；当前会话请用输入框上方的档位条或 /improve 调整。',
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
      },
      settings: {
        title: 'Modes and guard settings',
        subtitle: 'These values are defaults for **new sessions**, stored in the profile config and kept across restarts. For the current session use the mode bar above the composer or /improve.',
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
      },
    }

    const TIERS = ['normal', 'strict', 'extreme']

    const COLORS = {
      text: 'var(--dsw-alias-text-secondary, #8b8b8b)',
      strong: 'var(--dsw-alias-text-primary, #e6e6e6)',
      line: 'var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
      surface: 'var(--dsw-alias-surface-secondary, rgba(127,127,127,0.08))',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      accentSoft: 'var(--dsw-alias-brand-primary-muted, rgba(77,107,254,0.16))',
      warn: 'var(--dsw-alias-status-warning, #d98b0b)',
    }

    const rowStyle = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      padding: '4px 10px 6px',
      fontSize: '11px',
      lineHeight: '18px',
      color: COLORS.text,
      userSelect: 'none',
    }

    const groupStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
    }

    const segGroupStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      borderRadius: '999px',
      border: `1px solid ${COLORS.line}`,
      overflow: 'hidden',
      background: COLORS.surface,
    }

    function segStyle(active) {
      return {
        padding: '1px 8px',
        border: 'none',
        background: active ? COLORS.accentSoft : 'transparent',
        color: active ? COLORS.strong : COLORS.text,
        fontWeight: active ? 600 : 400,
        fontSize: '11px',
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        font: 'inherit',
      }
    }

    function chipStyle(active) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        padding: '1px 8px',
        borderRadius: '999px',
        border: `1px solid ${active ? COLORS.accent : COLORS.line}`,
        background: active ? COLORS.accentSoft : 'transparent',
        color: active ? COLORS.strong : COLORS.text,
        fontSize: '11px',
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        font: 'inherit',
      }
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

      // 写回 Host：官方通道是"会话命令"。客户端能用到的入口按可靠性排序试三条：
      //   1) sessions.binding(id).session.command(line) —— ISession.command，Host 侧直接走 commands.execute
      //   2) sessions.scope(id).remote.commands.execute(id, line, []) —— Agent 作用域的 typert remote
      //   3) ctx.get('remote').commands.execute(...) —— 某些宿主版本把连接级 remote 放在 ctx 上
      // 任何一条成功即可；全失败要报错（不静默失效），并带上失败原因。
      const runCommand = async (sessionId, line) => {
        const attempts = []
        const sessions = safeGet('sessions')

        const binding = safeCall(() => sessions?.binding?.(sessionId))
        if (typeof binding?.session?.command === 'function') {
          attempts.push({ label: 'session.command', run: () => binding.session.command(line) })
        }
        const scope = safeCall(() => sessions?.scope?.(sessionId))
        const scopedExecute = scope?.remote?.commands?.execute
        if (typeof scopedExecute === 'function') {
          attempts.push({
            label: 'scope.remote.commands.execute',
            run: () => scopedExecute.call(scope.remote.commands, sessionId, line, []),
          })
        }
        const remote = safeGet('remote')
        const directExecute = remote?.commands?.execute
        if (typeof directExecute === 'function') {
          attempts.push({
            label: 'remote.commands.execute',
            run: () => directExecute.call(remote.commands, sessionId, line, []),
          })
        }
        if (attempts.length === 0) throw new Error(t('noChannel'))

        let failure = null
        for (const attempt of attempts) {
          try {
            const result = await attempt.run()
            if (result && result.ok === false) {
              failure = new Error(result.error?.message ?? 'command failed')
              continue
            }
            if (result?.value && result.value.matched === false) {
              throw new Error('Host 没有注册 /improve 命令')
            }
            return result
          } catch (error) {
            failure = error
          }
        }
        throw failure ?? new Error('command failed')
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

        // 点击后先乐观更新（投影要等下一次会话事件才会推送），一旦投影带来新值就以投影为准。
        React.useEffect(() => {
          if (projected !== undefined) setLocal(undefined)
        }, [projected])

        const view = local ?? projected ?? {}
        const tier = TIERS.includes(view.tier) ? view.tier : 'normal'
        const adversarial = view.adversarial === true
        const idleGuard = view.idleGuard !== false
        const firstTurnFast = view.firstTurnFast !== false
        const marked = view.marked === true
        const degraded = view.capabilities?.streamIntercept === false

        const send = (args, optimistic) => {
          if (!sessionId) {
            setError(t('noSession'))
            return
          }
          if (optimistic) setLocal({ ...view, ...optimistic })
          setBusy(true)
          setError('')
          Promise.resolve()
            .then(() => runCommand(sessionId, `/improve ${args}`))
            .catch((failure) => {
              // 失败就回退乐观更新，并显示错误。
              setLocal(undefined)
              setError(`${t('error')}: ${failure?.message ?? failure}`)
            })
            .finally(() => setBusy(false))
        }

        const controls = [
          h(
            'span',
            { key: 'tier', style: groupStyle, title: t('hint.tier') },
            h('span', { style: { opacity: 0.75 } }, t('tier')),
            h(
              'span',
              { style: segGroupStyle },
              ...TIERS.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    style: segStyle(tier === id),
                    disabled: busy,
                    'aria-pressed': tier === id,
                    title: t(`hint.tier`),
                    onClick: () => send(`tier ${id}`, { tier: id }),
                  },
                  t(`tiers.${id}`),
                ),
              ),
            ),
          ),
          h(
            'button',
            {
              key: 'adversarial',
              type: 'button',
              style: chipStyle(adversarial),
              disabled: busy,
              'aria-pressed': adversarial,
              title: t('hint.adversarial'),
              onClick: () => send(`adversarial ${adversarial ? 'off' : 'on'}`, { adversarial: !adversarial }),
            },
            `${t('adversarial')} ${adversarial ? t('on') : t('off')}`,
          ),
          h(
            'button',
            {
              key: 'idleGuard',
              type: 'button',
              style: chipStyle(idleGuard),
              disabled: busy,
              'aria-pressed': idleGuard,
              title: t('hint.idleGuard'),
              onClick: () => send(`idleGuard ${idleGuard ? 'off' : 'on'}`, { idleGuard: !idleGuard }),
            },
            `${t('idleGuard')} ${idleGuard ? t('on') : t('off')}`,
          ),
          h(
            'button',
            {
              key: 'firstTurnFast',
              type: 'button',
              style: chipStyle(firstTurnFast),
              disabled: busy,
              'aria-pressed': firstTurnFast,
              title: t('hint.firstTurnFast'),
              onClick: () => send(`firstTurnFast ${firstTurnFast ? 'off' : 'on'}`, { firstTurnFast: !firstTurnFast }),
            },
            `${t('firstTurnFast')} ${firstTurnFast ? t('on') : t('off')}`,
          ),
        ]

        if (marked) {
          controls.push(
            h(
              'span',
              {
                key: 'marked',
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  padding: '1px 8px',
                  borderRadius: '999px',
                  border: `1px solid ${COLORS.warn}`,
                  color: COLORS.warn,
                  fontSize: '11px',
                },
                title: String(view.markReason ?? ''),
              },
              `⚠ ${t('idle')}`,
            ),
          )
        }

        if (degraded) {
          controls.push(
            h(
              'span',
              { key: 'degraded', style: { opacity: 0.7, fontSize: '11px' }, title: String(view.capabilities?.note ?? '') },
              `· ${t('degraded')}`,
            ),
          )
        }

        if (error) {
          controls.push(
            h('span', { key: 'error', style: { color: COLORS.warn, fontSize: '11px' } }, error),
          )
        }

        return h('div', { style: rowStyle, 'data-dsh-improve-think': 'bar' }, ...controls)
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

      const cardStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: '10px',
        border: `1px solid ${COLORS.line}`,
        background: COLORS.surface,
      }
      const titleStyle = { margin: 0, fontSize: '13px', fontWeight: 600, color: COLORS.strong }
      const subStyle = { margin: 0, fontSize: '11px', lineHeight: '17px', color: COLORS.text }
      const groupTitleStyle = { margin: '2px 0 0', fontSize: '11px', fontWeight: 600, color: COLORS.strong }
      const fieldRow = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '11px', lineHeight: '18px' }
      const fieldLabel = { minWidth: '140px', color: COLORS.text }
      const inputStyle = {
        width: '88px',
        padding: '3px 6px',
        fontSize: '11px',
        borderRadius: '6px',
        border: `1px solid ${COLORS.line}`,
        background: 'transparent',
        color: COLORS.strong,
        font: 'inherit',
      }
      const btnStyle = {
        padding: '3px 10px',
        fontSize: '11px',
        borderRadius: '6px',
        border: `1px solid ${COLORS.line}`,
        background: 'transparent',
        color: COLORS.text,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        font: 'inherit',
      }
      const statusStyle = { fontSize: '11px', color: COLORS.text }

      function settingsPanel() {
        return function DshImproveThinkSettings(props) {
          const { useSettings, saveField, resetAll } = props
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

          if (!snapshot || snapshot.status === 'loading') {
            return h(
              'div',
              { style: cardStyle, 'data-dsh-improve-think': 'settings' },
              h('p', { style: titleStyle }, t('settings.title')),
              h('p', { style: subStyle }, '…'),
            )
          }

          if (!ready) {
            return h(
              'div',
              { style: cardStyle, 'data-dsh-improve-think': 'settings' },
              h('p', { style: titleStyle }, t('settings.title')),
              h('p', { style: subStyle }, t('settings.unavailable')),
            )
          }

          const numberField = (field, label, format) =>
            h(
              'div',
              { key: field, style: { ...fieldRow, marginTop: '4px' } },
              h('span', { style: fieldLabel }, label),
              h('input', {
                type: 'text',
                inputMode: 'decimal',
                style: inputStyle,
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
                style: chipStyle(view[field] === true),
                title: t(`hint.${field}`),
                onClick: () => commit(field, view[field] !== true),
              },
              `${label} ${view[field] === true ? t('on') : t('off')}`,
            )

          const actionChip = (action, label) =>
            h(
              'button',
              {
                key: action,
                type: 'button',
                disabled: !writable,
                style: segStyle(view.idleGuardAction === action),
                onClick: () => commit('idleGuardAction', action),
              },
              label,
            )

          return h(
            'div',
            { style: cardStyle, 'data-dsh-improve-think': 'settings' },
            h('p', { style: titleStyle }, t('settings.title')),
            h('p', { style: subStyle }, t('settings.subtitle')),

            h('p', { style: groupTitleStyle }, t('settings.defaults')),
            h(
              'div',
              { style: segGroupStyle },
              ...TIERS.map((tier) =>
                h(
                  'button',
                  {
                    key: tier,
                    type: 'button',
                    disabled: !writable,
                    style: segStyle(view.tier === tier),
                    onClick: () => commit('tier', tier),
                  },
                  t(`tiers.${tier}`),
                ),
              ),
            ),

            h('p', { style: groupTitleStyle }, t('settings.toggles')),
            h(
              'div',
              { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
              ...SETTINGS_SWITCHES.map((field) => toggle(field, t(field))),
            ),

            h('p', { style: groupTitleStyle }, t('settings.guard')),
            h(
              'div',
              { style: fieldRow },
              h('span', { style: fieldLabel }, t('settings.action')),
              h(
                'div',
                { style: segGroupStyle },
                actionChip('observe', t('settings.observe')),
                actionChip('interrupt', t('settings.interrupt')),
              ),
            ),
            numberField('stagnationCount', t('settings.stagnation'), (v) => String(v ?? '')),
            numberField('reasoningSimilarityThreshold', t('settings.similarity'), (v) => (typeof v === 'number' ? v.toFixed(2) : '')),
            numberField('goalCheckInterval', t('settings.interval'), (v) => String(v ?? '')),
            numberField('minReasoningChars', t('settings.minChars'), (v) => String(v ?? '')),
            numberField('maxInterruptsPerStep', t('settings.maxInterrupts'), (v) => String(v ?? '')),

            h(
              'div',
              { style: { ...fieldRow, justifyContent: 'space-between', marginTop: '4px' } },
              h('span', { style: statusStyle }, status),
              h(
                'button',
                {
                  type: 'button',
                  disabled: !writable,
                  style: btnStyle,
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

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'dsh-improve-think',
            order: 20,
            label: () => t('label'),
            locale: NS,
          },
          tierBar(),
        ),
      )

      const configForms = safeGet('configForms')
      if (configForms && typeof configForms.get === 'function' && typeof configForms.whileServed === 'function') {
        const form = safeCall(() => configForms.get(SETTINGS_ENTRY_ID))
        if (form && typeof form.set === 'function') {
          const resetAll = async () => {
            for (const field of SETTINGS_ALL) {
              const ok = await form.unset(field)
              if (ok === false) return false
            }
            return true
          }
          ctx.effect(
            () =>
              configForms.whileServed([SETTINGS_ENTRY_ID], () =>
                ctx.slots.inject('plugins.bundle.config', () =>
                  ctx.slots.register(
                    {
                      name: 'plugins.bundle.config',
                      key: 'dsh-improve-think',
                      locale: NS,
                      inject: () => ({
                        hooks: { settings: form },
                        saveField: (field, value) => form.set(field, value),
                        resetAll,
                      }),
                    },
                    settingsPanel(),
                  ),
                ),
              ),
            'dsh-improve-think: settings panel',
          )
        }
      }
    }

    return { apply, inject: ['slots', 'locale'] }
  },
})
