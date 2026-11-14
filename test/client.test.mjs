// Client 半的离线渲染测试：不依赖真实浏览器，用最小 React/ctx 桩驱动 lib/client.js。
//
// 覆盖：
//  1. 模块 id / inject 契约（id 必须等于包名，inject 必须含 slots）；
//  2. 在 conversation.input.dock 注册，且 id/order/label 正确；
//  3. 投影值能渲染成档位条（含"疑似空转"与"降级"标记）；
//  4. 没有 useProjection 时退回默认值，不抛错；
//  5. 点击 → 首选 sessions.binding(id).session.command('/improve tier extreme')；
//  6. 没有 sessions 服务时退到 remote.commands.execute(sessionId, line, [])。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  // 迷你 hook 运行时：按组件身份存状态，这样同一个组件再渲染一次就能读到更新后的
  // 值（自检结果、收起按钮这类交互必须能跨渲染验证）。
  __hooks: new WeakMap(),
  __owner: null,
  __cursor: 0,
  useState(initial) {
    const owner = React.__owner
    const index = React.__cursor++
    if (!owner) return [initial, () => {}]
    let slots = React.__hooks.get(owner)
    if (!slots) {
      slots = []
      React.__hooks.set(owner, slots)
    }
    if (!(index in slots)) slots[index] = initial
    return [
      slots[index],
      (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      },
    ]
  },
  useEffect: () => {},
  __wrap(component) {
    const wrapped = (props) => {
      const previousOwner = React.__owner
      const previousCursor = React.__cursor
      React.__owner = wrapped
      React.__cursor = 0
      try {
        return component(props)
      } finally {
        React.__owner = previousOwner
        React.__cursor = previousCursor
      }
    }
    return wrapped
  },
}

let loaded

globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}

// 样式表通道：本包走 client-modules 的 __ModuleLoader__，宿主会在 factory 执行期间
// 认领它新建的 <style>（claimStyles）。这里用极小 document 桩验证我们真的建了标签——
// 之前误用 ctx.styles（动态双半包才有），样式表从未注入，界面上就是一排一样的灰按钮。
const appendedStyles = []
globalThis.document = {
  head: {
    appendChild: (node) => {
      appendedStyles.push(node)
      return node
    },
  },
  createElement: () => ({
    attrs: {},
    textContent: '',
    setAttribute(name, value) {
      this.attrs[name] = value
    },
  }),
  querySelector: () => null,
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const factory = new Function('require', 'window', source)
factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
}, globalThis.window)

assert.ok(loaded, 'client.js 应调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-improve-think', '模块 id 必须等于包名')

const plugin = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
assert.equal(typeof plugin.apply, 'function', 'client 半必须导出 apply')
// 宿主 cordis 只认字符串数组：对象形态（{required, optional}）会被折成两个叫
// "required"/"optional" 的服务，条目永远 pending，web boot 直接整页报错。
assert.ok(Array.isArray(plugin.inject), 'client 半的 inject 必须是字符串数组（宿主 cordis 不支持 {required, optional}）')
const declared = new Set(plugin.inject)
assert.ok(declared.has('slots'), 'inject 必须包含 slots')
assert.ok(declared.has('locale'), 'inject 必须包含 locale')
// 没声明的服务读不到，所以这两项必须显式声明。
assert.ok(declared.has('sessions'), 'inject 必须声明 sessions（会话命令通道）')
assert.ok(declared.has('configForms'), 'inject 必须声明 configForms（插件页设置表单）')
// 宿主把每个远程命名空间注册成独立服务 remote.<ns>，读属性那一瞬就抛错，
// 所以 remote 与 remote.commands 都必须声明（0.2.2 漏了，主页面按钮点不动）。
assert.ok(declared.has('remote'), 'inject 必须声明 remote')
assert.ok(declared.has('remote.commands'), 'inject 必须声明 remote.commands')

// 样式表必须真的被建出来（否则选中态只能靠内联兜底，且档位条会退回"一排灰按钮"）。
assert.equal(appendedStyles.length, 1, 'factory 内应恰好建一个 <style>')
const styleTag = appendedStyles[0]
assert.ok(
  String(styleTag.textContent).includes("[data-active='true']"),
  '样式表里要包含选中态的实心主色规则',
)
assert.equal(
  styleTag.attrs['data-dsh-improve-think-style'],
  '',
  '样式标签应带专属标记，便于排查与避免重复注入',
)

function makeHarness({
  withSessions = true,
  withRemote = true,
  withConfigForms = true,
  served = null,
  remoteGuard = false,
  strictFacet = false,
  statusText = null,
} = {}) {
  const registrations = []
  const calls = []
  const sessions = withSessions
    ? {
        binding: (sessionId) => ({
          session: {
            command: async (line) => {
              calls.push({ channel: 'session.command', sessionId, line })
              return { ok: true, value: { matched: true } }
            },
          },
        }),
      }
    : undefined
  const remote = withRemote
    ? {
        commands: {
          execute: async (sessionId, line, attachments) => {
            calls.push({ channel: 'remote.commands.execute', sessionId, line, attachments })
            return statusText === null
              ? { ok: true, value: { status: 'success' } }
              : { ok: true, value: { result: { kind: 'success', text: statusText } } }
          },
        },
      }
    : undefined

  // configForms 桩：模拟 Host `settings` 服务在插件页投影出的表单控制器。
  const formWrites = []
  const formResets = []
  const formEntryIds = []
  const servedNamespaces = []
  const form = {
    snapshot: {
      status: 'ready',
      writable: true,
      revision: 3,
      value: {
        tier: 'normal',
        adversarial: false,
        idleGuard: true,
        firstTurnFast: true,
        idleGuardAction: 'interrupt',
        stagnationCount: 3,
        reasoningSimilarityThreshold: 0.8,
        goalCheckInterval: 5,
        minReasoningChars: 80,
        maxInterruptsPerStep: 1,
      },
    },
    getSnapshot() {
      return this.snapshot
    },
    subscribe() {
      return () => {}
    },
    async set(field, value) {
      formWrites.push({ field, value })
      return true
    },
    async unset(field) {
      formResets.push(field)
      return true
    },
  }
  const configForms = withConfigForms
    ? {
        get(entryId) {
          formEntryIds.push(entryId)
          return form
        },
        whileServed(namespaces, register) {
          servedNamespaces.push(...namespaces)
          // 默认模拟 Host 服务全部候选 namespace（真实主机就是其中被服务的那一个）。
          return register(new Set(served ?? namespaces))
        },
      }
    : undefined

  const services = { sessions, configForms }
  const ctx = {
    effect: (callback) => {
      callback()
      return () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, component) => {
        registrations.push({ definition, component: React.__wrap(component) })
        return () => {}
      },
    },
    get: (service) => {
      // 模拟宿主守卫：没在 inject 里声明的远程服务，读属性那一瞬就抛错。
      if (service === 'remote' && remoteGuard) {
        throw new Error("cannot get property 'remote.commands' without inject")
      }
      return service === 'remote' ? remote : services[service]
    },
  }
  Object.defineProperty(ctx, 'remote', {
    get() {
      if (remoteGuard) throw new Error("cannot get property 'remote.commands' without inject")
      return remote
    },
  })
  // strictFacet：模拟受限 facade —— 读任何未声明服务都会立刻抛错（与真实宿主一致）。
  // 用来兜住"直接 ctx.styles / ctx.remote 裸读"这类会让 apply 抛错、整页启动失败的写法。
  const builtins = new Set(['get', 'on', 'provide', 'effect', 'fiber'])
  const faceted = strictFacet
    ? new Proxy(ctx, {
        get(target, prop) {
          if (typeof prop !== 'string' || builtins.has(prop) || declared.has(prop) || prop in target) {
            return Reflect.get(target, prop)
          }
          throw new Error(`cannot get property '${prop}' without inject`)
        },
      })
    : ctx
  plugin.apply(faceted)
  return { registrations, calls, formWrites, formResets, formEntryIds, servedNamespaces, form }
}

const findSlot = (registrations, name) => registrations.find((entry) => entry.definition.name === name)

function textsOf(node, bucket = []) {
  if (node === null || node === undefined || node === false) return bucket
  if (typeof node === 'string' || typeof node === 'number') {
    bucket.push(String(node))
    return bucket
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, bucket)
    return bucket
  }
  if (node.children) textsOf(node.children, bucket)
  return bucket
}

function allNodes(node, bucket = []) {
  if (!node || typeof node !== 'object') return bucket
  if (Array.isArray(node)) {
    for (const child of node) allNodes(child, bucket)
    return bucket
  }
  bucket.push(node)
  if (node.children) allNodes(node.children, bucket)
  return bucket
}

// ---- 1. 注册进 composer dock -------------------------------------------------
{
  const { registrations } = makeHarness()
  assert.equal(registrations.length, 2, '应注册 dock 条目 + 插件页设置面板')
  const { definition } = findSlot(registrations, 'conversation.input.dock')
  assert.equal(definition.name, 'conversation.input.dock')
  assert.equal(definition.id, 'dsh-improve-think')
  assert.equal(definition.order, 30)
  assert.equal(typeof definition.label, 'function')
  assert.equal(definition.label(), 'label')
}

const findHintButton = (tree, hint) =>
  allNodes(tree).find((node) => node.type === 'button' && node.props?.title === hint)

// ---- 2. 投影渲染 -------------------------------------------------------------
{
  const { registrations } = makeHarness()
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({
    sessionId: 'session-1',
    useProjection: () => ({
      tier: 'extreme',
      adversarial: true,
      idleGuard: true,
      firstTurnFast: false,
      marked: true,
      markReason: 'stream-repetitive (similarity=0.93)',
      capabilities: { streamIntercept: false, degraded: true, note: 'no-stream' },
    }),
  })
  const texts = textsOf(tree)
  const extreme = allNodes(tree).find((node) => node.type === 'button' && node.props?.['aria-pressed'] === true && textsOf(node).includes('tiers.extreme'))
  assert.ok(extreme, `极致档应是选中态：${texts.join(',')}`)
  assert.equal(findHintButton(tree, 'hint.adversarial')?.props['aria-pressed'], true, '对抗应显示为开')
  assert.equal(findHintButton(tree, 'hint.idleGuard')?.props['aria-pressed'], true, '空转守护应显示为开')
  assert.equal(findHintButton(tree, 'hint.firstTurnFast')?.props['aria-pressed'], false, '首轮快跳应显示为关')
  // 开关态用小圆点表示：开=实心，关=空心描边。
  const dot = findHintButton(tree, 'hint.adversarial').children[0]
  assert.equal(dot.props.className, 'dit-dot', '开关态圆点应走 dit-dot 样式类')
  assert.ok(texts.some((text) => text.includes('idle') && text.includes('⚠')), '应出现疑似空转标记')
  assert.ok(texts.some((text) => text.includes('degraded')), '应出现降级标记')

  // 空转标记的 tooltip 带原因，便于复盘。
  const marked = allNodes(tree).find((node) => node.props?.title === 'stream-repetitive (similarity=0.93)')
  assert.ok(marked, '疑似空转标记应带 markReason tooltip')
}

// ---- 3. 无投影时退回默认值 ---------------------------------------------------
{
  const { registrations } = makeHarness()
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({ sessionId: 'session-2' })
  const texts = textsOf(tree)
  const normal = allNodes(tree).find((node) => node.type === 'button' && node.props?.['aria-pressed'] === true)
  assert.ok(normal && textsOf(normal).includes('tiers.normal'), '没有投影时默认常规档')
  assert.equal(findHintButton(tree, 'hint.idleGuard')?.props['aria-pressed'], true, '没有投影时空转守护默认开')
  assert.equal(findHintButton(tree, 'hint.firstTurnFast')?.props['aria-pressed'], true, '没有投影时首轮快跳默认开')
  assert.ok(!texts.some((text) => text.includes('degraded')), '未知能力时不应谎报降级')
}

// ---- 4. 点击写回 Host --------------------------------------------------------
{
  const { registrations, calls } = makeHarness()
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({
    sessionId: 'session-3',
    useProjection: () => ({ tier: 'normal', adversarial: false, idleGuard: true, firstTurnFast: true }),
  })
  const buttons = allNodes(tree).filter((node) => node.type === 'button')
  assert.ok(buttons.length >= 6, `应有档位与开关按钮，实际 ${buttons.length}`)
  const extreme = buttons.find((button) => textsOf(button).includes('tiers.extreme'))
  assert.ok(extreme, '应找到极致档按钮')
  extreme.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls[0], {
    channel: 'remote.commands.execute',
    sessionId: 'session-3',
    line: '/improve tier extreme',
    attachments: [],
  })
}

// ---- 5. 没有 sessionId 时不发命令 -------------------------------------------
{
  const { registrations, calls } = makeHarness()
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({ useProjection: () => ({ tier: 'normal' }) })
  const buttons = allNodes(tree).filter((node) => node.type === 'button')
  buttons[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 0, '没有 sessionId 时不应调用 commands.execute')
}

// ---- 6. 没有 remote 命名空间时退回 ISession.command（旧宿主兜底） -------------
{
  const { registrations, calls } = makeHarness({ withRemote: false })
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({ sessionId: 'session-4', useProjection: () => ({ tier: 'normal' }) })
  const buttons = allNodes(tree).filter((node) => node.type === 'button')
  const strict = buttons.find((button) => textsOf(button).includes('tiers.strict'))
  assert.ok(strict, '应找到严格档按钮')
  strict.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls[0], {
    channel: 'session.command',
    sessionId: 'session-4',
    line: '/improve tier strict',
  })
}

// ---- 7. 插件页设置面板：注册、读快照、写回 -----------------------------------
{
  const { registrations, formWrites, formResets, formEntryIds, servedNamespaces } = makeHarness()
  const panel = findSlot(registrations, 'plugins.bundle.config')
  assert.ok(panel, '应注册 plugins.bundle.config')
  assert.equal(panel.definition.key, 'dsh-improve-think', '插槽 key 必须是包名')
  assert.deepEqual(
    formEntryIds,
    ['dsh-improve-think', 'dsh-improve-think'],
    '先按包名取表单（本机 Settings namespace 就是包名），whileServed 报告后再取一次',
  )
  assert.deepEqual(
    servedNamespaces,
    ['dsh-improve-think', 'include:dsh-improve-think'],
    'whileServed 应收到两个候选 namespace，包名优先',
  )

  const injected = panel.definition.inject()
  assert.equal(typeof injected.saveField, 'function')
  assert.equal(typeof injected.resetAll, 'function')
  // hooks.settings 是稳定的 observable 源（getSnapshot/subscribe），控制器换了不用重注册。
  const source = injected.hooks.settings
  assert.equal(typeof source.getSnapshot, 'function')
  assert.equal(typeof source.subscribe, 'function')
  assert.equal(source.getSnapshot().status, 'ready')

  const Component = panel.component
  const tree = Component({ ...injected, useSettings: (selector) => selector(source.getSnapshot()) })
  const texts = textsOf(tree)
  // 详情页标题由 DSH 插件页自己出，我们只放一行说明，避免重复标题。
  assert.ok(texts.includes('settings.subtitle'), `应渲染设置面板说明：${texts.join(',')}`)
  assert.ok(texts.includes('settings.guard'), '应渲染空转守护参数分组')
  assert.ok(texts.some((text) => text.startsWith('adversarial off')), '对抗默认关')
  const inputs = allNodes(tree).filter((node) => node.type === 'input')
  assert.equal(inputs.length, 5, '应有 5 个数字输入框')
  assert.ok(
    inputs.some((input) => input.props.value === '0.80'),
    `相似度阈值应格式化两位小数：${inputs.map((input) => input.props.value).join(',')}`,
  )

  const buttons = allNodes(tree).filter((node) => node.type === 'button')
  const strict = buttons.find((button) => textsOf(button).includes('tiers.strict'))
  assert.ok(strict, '应找到严格档按钮')
  await strict.props.onClick()
  assert.deepEqual(formWrites[0], { field: 'tier', value: 'strict' }, '点档位应写回 Host 配置')

  const interrupt = buttons.find((button) => textsOf(button).includes('settings.interrupt'))
  await interrupt.props.onClick()
  assert.deepEqual(formWrites[1], { field: 'idleGuardAction', value: 'interrupt' })

  const restore = buttons.find((button) => textsOf(button).includes('settings.restore'))
  await restore.props.onClick()
  assert.ok(formResets.length >= 8, `恢复默认应逐字段 unset，实际 ${formResets.length}`)
  assert.ok(formResets.includes('tier') && formResets.includes('goalCheckInterval'))
}

// ---- 8. 没有 configForms 时仍然注册面板，但如实显示"宿主未提供配置" -------------
{
  const { registrations } = makeHarness({ withConfigForms: false })
  assert.equal(registrations.length, 2, '无 configForms 时仍要注册 dock 条目 + 设置面板（不能静默消失）')
  const panel = findSlot(registrations, 'plugins.bundle.config')
  assert.ok(panel, '无 configForms 时也要有设置面板占位')
  const injected = panel.definition.inject()
  assert.equal(injected.hooks.settings.getSnapshot().status, 'unavailable')
  const tree = panel.component({ ...injected, useSettings: (selector) => selector(injected.hooks.settings.getSnapshot()) })
  const texts = textsOf(tree)
  assert.ok(texts.includes('settings.unavailable'), `应如实提示宿主未提供配置：${texts.join(',')}`)
  assert.throws(() => injected.saveField('tier', 'strict'), /settings\.unavailable/)
}

// ---- 9. Host 只服务包名形式的 namespace 时，面板用包名取表单 ----------------
{
  const { registrations, formEntryIds } = makeHarness({ served: ['dsh-improve-think'] })
  const panel = findSlot(registrations, 'plugins.bundle.config')
  assert.ok(panel, '只服务包名 namespace 时也应注册设置面板')
  assert.equal(formEntryIds.at(-1), 'dsh-improve-think', '应按实际被服务的 namespace 取表单')
}

// ---- 10. 默认值 / 会话覆盖：覆盖压过默认值，且能一键恢复 ---------------------
{
  const { registrations, calls } = makeHarness()
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({
    sessionId: 'session-5',
    useProjection: () => ({
      tier: 'normal',
      defaults: { tier: 'extreme', adversarial: false, idleGuard: true, firstTurnFast: true },
      overrides: { tier: 'normal' },
      overrideKeys: ['tier'],
    }),
  })
  const active = allNodes(tree).find((node) => node.type === 'button' && node.props?.['aria-pressed'] === true)
  assert.ok(textsOf(active).includes('tiers.normal'), '本会话覆盖应压过插件页默认值')

  const reset = allNodes(tree).find((node) => node.type === 'button' && node.props?.title === 'hint.reset')
  assert.ok(reset, '存在会话覆盖时应出现「恢复默认值」按钮')
  reset.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.at(-1).line, '/improve reset', '恢复按钮应发送 /improve reset')
}

// ---- 11. 没有会话覆盖时，档位条实时跟随插件页默认值 -------------------------
{
  const { registrations } = makeHarness()
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({
    sessionId: 'session-6',
    useProjection: () => ({
      tier: 'normal',
      defaults: { tier: 'extreme', adversarial: true, idleGuard: true, firstTurnFast: true },
      overrides: {},
      overrideKeys: [],
    }),
  })
  const active = allNodes(tree).find((node) => node.type === 'button' && node.props?.['aria-pressed'] === true)
  assert.ok(textsOf(active).includes('tiers.extreme'), '没有覆盖时应显示插件页默认档位')
  assert.equal(findHintButton(tree, 'hint.adversarial')?.props['aria-pressed'], true, '开关也应跟默认值')
  assert.equal(
    allNodes(tree).find((node) => node.type === 'button' && node.props?.title === 'hint.reset'),
    undefined,
    '没有覆盖时不应出现恢复按钮',
  )
}

// ---- 12. 宿主把 remote 通道锁住时，点击仍然走 sessions 通道 -------------------
{
  const { registrations, calls } = makeHarness({ remoteGuard: true })
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({ sessionId: 'session-7' })
  const extreme = allNodes(tree).find((node) => node.type === 'button' && textsOf(node).includes('tiers.extreme'))
  assert.ok(extreme, '应有极致档按钮')
  extreme.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 1, `不应触发 remote 通道：${JSON.stringify(calls)}`)
  assert.equal(calls[0].channel, 'session.command', '应走 ISession.command')
  assert.equal(calls[0].line, '/improve tier extreme')
}

// ---- 13. 所有通道都被锁住时，点击只失败不崩溃（错误走组件内状态） -------------
{
  const { registrations, calls } = makeHarness({ withSessions: false, remoteGuard: true })
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({ sessionId: 'session-8' })
  const normal = allNodes(tree).find((node) => node.type === 'button' && textsOf(node).includes('tiers.normal'))
  // 点击必须吞掉通道错误（否则会冒泡成未处理的 Promise 拒绝，把整个目录树带崩）。
  normal.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 0, '没有通道时不应发出任何命令')
}

// ---- 14. 受限 facade：apply 期间不得裸读未声明服务（否则整页启动失败） --------
{
  const { registrations } = makeHarness({ strictFacet: true })
  assert.equal(registrations.length, 2, '受限 facade 下仍应注册档位条与设置面板')
  const names = registrations.map((entry) => entry.definition.name).sort()
  assert.deepEqual(names, ['conversation.input.dock', 'plugins.bundle.config'])
}

// ---- 15. 选中态与自检：一眼能看出选了哪个，并能拿到 Host 的真实状态 ----------
{
  const statusText = '思考档：严谨 · 守护：开 · 已生效'
  const { registrations, calls } = makeHarness({ statusText })
  const Component = findSlot(registrations, 'conversation.input.dock').component
  const tree = Component({
    sessionId: 'session-9',
    useProjection: () => ({ tier: 'strict', adversarial: false, idleGuard: true, firstTurnFast: true }),
  })

  // 思考档有可见标签，且三个档位在同一轨道里（分段控件）
  assert.ok(textsOf(tree).includes('tier'), '档位条应有「思考档」这一小标题')
  const track = allNodes(tree).find((node) => node.props?.className === 'dit-track')
  assert.ok(track, '档位应是分段控件（dit-track）')

  // 选中项带 data-active，且开关把「开/关」写出来——只看颜色深浅不够
  const tierButtons = allNodes(tree).filter((node) => node.type === 'button')
  const strictButton = tierButtons.find((node) => textsOf(node).includes('tiers.strict'))
  assert.equal(strictButton.props['data-active'], 'true', '选中档位必须标记 data-active')
  assert.equal(
    tierButtons.find((node) => textsOf(node).includes('tiers.normal')).props['data-active'],
    'false',
    '未选中档位不得标记 data-active',
  )
  const texts = textsOf(tree)
  assert.ok(texts.includes('adversarial off'), '关闭的开关应直接写出「关」')
  assert.ok(texts.includes('idleGuard on'), '开启的开关应直接写出「开」')

  // 自检：点一下向 Host 要真实状态，并把返回文本铺在条内
  const verifyButton = allNodes(tree).find(
    (node) => node.type === 'button' && node.props?.title === 'hint.verify',
  )
  assert.ok(verifyButton, '档位条应有自检按钮')
  verifyButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.at(-1).line, '/improve status', '自检应执行 /improve status')

  // 重新渲染拿到更新后的 state（迷你 React 按组件身份保存状态）
  const rendered = Component({
    sessionId: 'session-9',
    useProjection: () => ({ tier: 'strict', adversarial: false, idleGuard: true, firstTurnFast: true }),
  })
  assert.ok(rendered, '自检后组件仍应可渲染')
  const reportNode = allNodes(rendered).find((node) => node.props?.className === 'dit-report')
  assert.ok(reportNode, '自检结果应铺在条内第二行')
  assert.ok(textsOf(rendered).includes(statusText), '自检结果应显示 Host 返回的真实状态')
  assert.ok(
    allNodes(rendered).some(
      (node) => node.type === 'button' && String(textsOf(node)).includes('verifyHide'),
    ),
    '有结果时自检按钮应变成「收起」',
  )

  // 结果不能只能刷新页面才清掉：× 与再次点自检都要能收起。
  const closeButton = allNodes(rendered).find(
    (node) => node.type === 'button' && node.props?.className === 'dit-report-close',
  )
  assert.ok(closeButton, '自检结果应带显式收起按钮')
  closeButton.props.onClick()
  const collapsed = Component({
    sessionId: 'session-9',
    useProjection: () => ({ tier: 'strict', adversarial: false, idleGuard: true, firstTurnFast: true }),
  })
  assert.equal(
    allNodes(collapsed).find((node) => node.props?.className === 'dit-report'),
    undefined,
    '点 × 之后自检结果应消失',
  )
}

console.log('client.test.mjs：15 组断言全部通过')
