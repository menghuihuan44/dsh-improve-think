// Client 半的离线渲染测试：不依赖真实浏览器，用最小 React/ctx 桩驱动 lib/client.js。
//
// 覆盖：
//  1. 模块 id / inject 契约（id 必须等于包名，inject 必须含 slots）；
//  2. 在 conversation.composer.dock 注册，且 id/order/label 正确；
//  3. 投影值能渲染成档位条（含"疑似空转"与"降级"标记）；
//  4. 没有 useProjection 时退回默认值，不抛错；
//  5. 点击 → 首选 sessions.binding(id).session.command('/improve tier extreme')；
//  6. 没有 sessions 服务时退到 remote.commands.execute(sessionId, line, [])。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

let loaded

globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
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

function makeHarness({ withSessions = true, withRemote = true, withConfigForms = true, served = null } = {}) {
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
            return { ok: true, value: { status: 'success' } }
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

  const services = { sessions, remote, configForms }
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
        registrations.push({ definition, component })
        return () => {}
      },
    },
    get: (service) => services[service],
  }
  plugin.apply(ctx)
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
  const { definition } = findSlot(registrations, 'conversation.composer.dock')
  assert.equal(definition.name, 'conversation.composer.dock')
  assert.equal(definition.id, 'dsh-improve-think')
  assert.equal(definition.order, 20)
  assert.equal(typeof definition.label, 'function')
  assert.equal(definition.label(), 'label')
}

// ---- 2. 投影渲染 -------------------------------------------------------------
{
  const { registrations } = makeHarness()
  const Component = findSlot(registrations, 'conversation.composer.dock').component
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
  assert.ok(texts.includes('tiers.extreme'), `应高亮极致档：${texts.join(',')}`)
  assert.ok(texts.some((text) => text.startsWith('adversarial on')), '对抗应显示为开')
  assert.ok(texts.some((text) => text.startsWith('idleGuard on')), '空转守护应显示为开')
  assert.ok(texts.some((text) => text.startsWith('firstTurnFast off')), '首轮快跳应显示为关')
  assert.ok(texts.some((text) => text.includes('idle') && text.includes('⚠')), '应出现疑似空转标记')
  assert.ok(texts.some((text) => text.includes('degraded')), '应出现降级标记')

  // 空转标记的 tooltip 带原因，便于复盘。
  const marked = allNodes(tree).find((node) => node.props?.title === 'stream-repetitive (similarity=0.93)')
  assert.ok(marked, '疑似空转标记应带 markReason tooltip')
}

// ---- 3. 无投影时退回默认值 ---------------------------------------------------
{
  const { registrations } = makeHarness()
  const Component = findSlot(registrations, 'conversation.composer.dock').component
  const tree = Component({ sessionId: 'session-2' })
  const texts = textsOf(tree)
  assert.ok(texts.includes('tiers.normal'), '没有投影时默认常规档')
  assert.ok(texts.some((text) => text.startsWith('idleGuard on')), '没有投影时空转守护默认开')
  assert.ok(texts.some((text) => text.startsWith('firstTurnFast on')), '没有投影时首轮快跳默认开')
  assert.ok(!texts.some((text) => text.includes('degraded')), '未知能力时不应谎报降级')
}

// ---- 4. 点击写回 Host --------------------------------------------------------
{
  const { registrations, calls } = makeHarness()
  const Component = findSlot(registrations, 'conversation.composer.dock').component
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
    channel: 'session.command',
    sessionId: 'session-3',
    line: '/improve tier extreme',
  })
}

// ---- 5. 没有 sessionId 时不发命令 -------------------------------------------
{
  const { registrations, calls } = makeHarness()
  const Component = findSlot(registrations, 'conversation.composer.dock').component
  const tree = Component({ useProjection: () => ({ tier: 'normal' }) })
  const buttons = allNodes(tree).filter((node) => node.type === 'button')
  buttons[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 0, '没有 sessionId 时不应调用 commands.execute')
}

// ---- 6. 没有 sessions 服务时退到 remote.commands.execute ---------------------
{
  const { registrations, calls } = makeHarness({ withSessions: false })
  const Component = findSlot(registrations, 'conversation.composer.dock').component
  const tree = Component({ sessionId: 'session-4', useProjection: () => ({ tier: 'normal' }) })
  const buttons = allNodes(tree).filter((node) => node.type === 'button')
  const strict = buttons.find((button) => textsOf(button).includes('tiers.strict'))
  assert.ok(strict, '应找到严格档按钮')
  strict.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls[0], {
    channel: 'remote.commands.execute',
    sessionId: 'session-4',
    line: '/improve tier strict',
    attachments: [],
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
  assert.ok(texts.includes('settings.title'), `应渲染设置面板标题：${texts.join(',')}`)
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

console.log('client.test.mjs：9 组断言全部通过')
