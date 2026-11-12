/**
 * 自测脚本：用假的 Cordis ctx 驱动 dsh-improve-think 的宿主半边，覆盖需求第七节的 6 条验收标准。
 *
 * 运行：node scripts/selftest.mjs
 * 输出：每条验收标准的 PASS/FAIL 与证据（日志事件、followup 文本、注入了什么提示词）。
 *
 * 说明：这里不启动真实 DSH，也不请求模型；它验证的是"插件在这些信号下会做什么决定"，
 * 真实会话里的行为见 README「验收记录」。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Config, apply } from '../lib/index.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error?.message ?? error}`)
  }
}

function makeSessionStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-improve-think-selftest-'))
  return path.join(dir, 'state.json')
}

/** 极简 Cordis ctx 替身：只实现插件用到的那几个面。 */
function createFakeHost({
  config = {},
  withStreamHook = true,
  withCommands = true,
  withProjections = false,
  withTools = false,
  settingsRows = null,
} = {}) {
  const listeners = new Map()
  const effects = []
  const sections = []
  const commands = new Map()
  const tools = new Map()
  const logs = []
  const followups = []
  const followupMessages = []
  const projections = []

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    on(name, handler) {
      // 模拟"当前版本没有流式推理拦截点"：注册被静默忽略（宿主不接受该事件）。
      if (name === 'llm/stream' && !withStreamHook) return () => {}
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(
          name,
          current.filter((item) => item !== handler),
        )
      }
    },
    inject(deps, callback) {
      const available = deps.every((dep) =>
        dep === 'commands'
          ? withCommands
          : dep === 'sessionProjections'
            ? withProjections
            : dep === 'tools'
              ? withTools
              : false,
      )
      if (available) callback(ctx)
    },
    get(name) {
      if (name === 'commands' && withCommands) return ctx.commands
      if (name === 'sessionProjections' && withProjections) return ctx.sessionProjections
      if (name === 'tools' && withTools) return ctx.tools
      if (name === 'settings' && settingsRows !== null) return { describe: () => settingsRows }
      return undefined
    },
    provide() {},
    sessionProjections: withProjections
      ? {
          register(unit) {
            projections.push(unit)
            return () => {}
          },
        }
      : undefined,
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
    commands: withCommands
      ? {
          register(definition) {
            commands.set(definition.name, definition)
            return () => commands.delete(definition.name)
          },
        }
      : undefined,
    tools: withTools
      ? {
          register(definition) {
            if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
        }
      : undefined,
  }

  // 关掉流式 hook 的场景：插件注册 llm/stream 时会被上面的 ctx.on 直接忽略。

  const agent = {
    session: { id: 'session-selftest' },
    followup: (message) => {
      // 真实 Agent loop 要求传完整 message 对象；测试里同时兼容字符串，便于断言。
      const text =
        typeof message === 'string'
          ? message
          : (message?.content ?? [])
              .map((block) => block?.text ?? '')
              .join('')
      followups.push(text)
      followupMessages.push(message)
      return undefined
    },
  }

  function emitSessionEvent(type, data, sessionId = 'session-selftest') {
    const event = { type, data, seq: 0, time: Date.now() }
    for (const handler of listeners.get('session/event') ?? []) handler({ id: sessionId }, event)
  }

  async function runStep(chunks, { turn, step, sessionId = 'session-selftest' } = {}) {
    const handlers = listeners.get('llm/stream') ?? []
    const produced = []
    if (handlers.length === 0) return produced
    const upstream = async function* source() {
      for (const chunk of chunks) yield chunk
    }
    const next = () => upstream()
    let iterable = null
    for (const handler of handlers) {
      iterable = iterable === null ? handler({ sessionId, messages: [] }, next) : handler({ sessionId, messages: [] }, next)
    }
    if (!iterable) return produced
    for await (const chunk of iterable) produced.push(chunk)
    return produced
  }

  function sectionText(forAgent = agent) {
    const spec = sections[0]
    if (!spec) return ''
    return typeof spec.text === 'function' ? spec.text({ agent: forAgent }) : spec.text
  }

  return {
    ctx,
    agent,
    listeners,
    sections,
    commands,
    tools,
    projections,
    logs,
    followups,
    followupMessages,
    emitSessionEvent,
    runStep,
    sectionText,
    effects,
  }
}

/** 启动插件，并模拟宿主在 agent 创建后广播 agent/created。 */
function startPlugin(host, config) {
  apply(host.ctx, config)
  for (const handler of host.listeners.get('agent/created') ?? []) {
    handler({ agent: host.agent })
  }
}

function reasoningChunks(text, index = 0) {
  return [
    { type: 'block-start', index, blockType: 'reasoning' },
    { type: 'reasoning-delta', index, text },
    { type: 'block-end', index, block: { type: 'reasoning', text } },
    { type: 'block-start', index: index + 1, blockType: 'text' },
    { type: 'text-delta', index: index + 1, text: '' },
    { type: 'block-end', index: index + 1, block: { type: 'text', text: '' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function textChunks(text, index = 0) {
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(toolName, index = 0) {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: `call-${index}`, name: toolName, argumentsDelta: '{}' },
    { type: 'block-end', index, block: { type: 'tool-call', id: `call-${index}`, name: toolName, arguments: {} } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function runTurn(host, { turn, text = '好', reasoning = '', tool = null, observe = true }) {
  const { emitSessionEvent, runStep, agent } = host
  if (observe) emitSessionEvent('turn/start', { turn })
  emitSessionEvent('step/start', { turn, step: 1 })
  if (tool) {
    emitSessionEvent('tool/call', { turn, step: 1, name: tool, callId: `call-${turn}` })
    await runStep(toolChunks(tool), { turn, step: 1 })
  } else if (reasoning) {
    await runStep(reasoningChunks(reasoning), { turn, step: 1 })
  } else {
    await runStep(textChunks(text), { turn, step: 1 })
  }
  emitSessionEvent('step/end', { turn, step: 1 })
  if (observe) emitSessionEvent('turn/end', { turn, reason: { kind: 'completed' } })
  return agent
}

/** 读插件写出的 JSONL 日志。 */
function readLog(logDir, sessionId = 'session-selftest') {
  const file = path.join(logDir, `${sessionId}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const tmpState = makeSessionStateFile()
const tmpState2 = makeSessionStateFile()
const tmpState3 = makeSessionStateFile()
const tmpState4 = makeSessionStateFile()

// ═══════════════════════════════════════ 1. 空转模拟

async function scenarioStagnation() {
  const statePath = tmpState
  const host = createFakeHost({ config: { statePath, logDir: path.dirname(statePath) } })
  startPlugin(host, { statePath, logDir: path.dirname(statePath) })

  // 先切到 observe：只记录、不打断。
  const command = host.commands.get('improve')
  assert.ok(command, '应注册 improve 命令（UI 写回通道）')
  const observeResult = await command.handler({ agent: host.agent, rawInput: 'observe' })
  assert.equal(observeResult.kind, 'success')
  assert.equal(host.followups.length, 0)

  for (let turn = 1; turn <= 5; turn += 1) {
    await runTurn(host, { turn, text: '好' })
  }
  const logs = readLog(path.dirname(statePath))
  const observed = logs.filter((entry) => entry.event === 'idle.observe')
  assert.ok(observed.length >= 2, `observe 模式应记录疑似空转，实际 ${observed.length} 条`)
  const correctionsDuringObserve = host.followups.filter((text) => text.includes('没有产生新进展'))
  assert.equal(correctionsDuringObserve.length, 0, 'observe 模式不得注入纠正提示（目标对照是另一条独立提醒）')
  assert.equal(logs.filter((entry) => entry.event === 'idle.interrupt').length, 0)

  // 再切到 interrupt：达到阈值后应注入纠正提示并让任务继续（followup）。
  await command.handler({ agent: host.agent, rawInput: 'interrupt' })
  for (let turn = 6; turn <= 9; turn += 1) {
    await runTurn(host, { turn, text: '好' })
  }
  const logs2 = readLog(path.dirname(statePath))
  const interrupts = logs2.filter((entry) => entry.event === 'idle.interrupt' || entry.event === 'idle.interrupt.stream')
  assert.ok(interrupts.length >= 1, 'interrupt 模式应产生打断日志')
  assert.ok(host.followups.length >= 1, '打断后应 followup 让任务继续，而不是终止会话')
  assert.ok(
    host.followups.some((text) => text.includes('没有产生新进展')),
    `纠正提示应包含"没有产生新进展"，实际：${host.followups.join(' | ')}`,
  )
  return { observed: observed.length, interrupts: interrupts.length, followups: host.followups.length }
}

// ═══════════════════════════════════════ 2. 正常复杂任务

async function scenarioComplexTask() {
  const statePath = tmpState2
  const host = createFakeHost({ config: { statePath, logDir: path.dirname(statePath) } })
  startPlugin(host, { statePath, logDir: path.dirname(statePath) })

  const longReasoning =
    '先读 lib/index.js 确认 hook 注册点，再读 state-store.js 看落盘格式，' +
    '然后决定事件监听放在 apply 内还是 per-agent；注意 waterfall 必须 return decision，' +
    '否则 pipeline 会在 gate.kind 处抛 TypeError。'
  for (let turn = 1; turn <= 12; turn += 1) {
    await runTurn(host, {
      turn,
      reasoning: `${longReasoning} 第 ${turn} 轮追加：现在检查第 ${turn} 个模块。`,
      tool: turn % 3 === 0 ? 'read' : 'pwsh',
    })
  }
  const logs = readLog(path.dirname(statePath))
  assert.equal(logs.filter((entry) => entry.event === 'idle.interrupt').length, 0, '正常任务不得被打断')
  assert.equal(logs.filter((entry) => entry.event === 'idle.interrupt.stream').length, 0, '正常任务不得被流内掐断')
  assert.equal(host.followups.filter((text) => text.includes('没有产生新进展')).length, 0, '正常任务不得注入纠正提示')
  // 目标对照属于定期自检（第 5、10 轮），不打断任务，是允许的。
  assert.ok(host.followups.every((text) => text.includes('目标对照')), '正常任务的唯一额外消息应是目标对照')
  return { turns: 12, interruptions: 0, goalChecks: host.followups.length }
}

// ═══════════════════════════════════════ 3. 首轮快跳

async function scenarioFirstTurnFast() {
  const statePath = tmpState3
  const host = createFakeHost({ config: { statePath, logDir: path.dirname(statePath) } })
  startPlugin(host, { statePath, logDir: path.dirname(statePath) })

  const first = host.sectionText()
  assert.ok(first.includes('首轮快跳'), '首轮应注入快跳约束')
  assert.ok(first.includes('后续轮次仍可进行深度推理'), '快跳不得关闭后续深度推理')

  await runTurn(host, { turn: 1, tool: 'read' })
  await runTurn(host, { turn: 2, tool: 'read' })
  const later = host.sectionText()
  assert.ok(!later.includes('首轮快跳'), '后续轮次不应再注入快跳约束')
  assert.ok(later.includes('路线校准'), '路线校准规范应始终存在')
  return { firstHasFastStart: true, laterHasFastStart: false }
}

// ═══════════════════════════════════════ 4. 极致档 + 对抗审查

async function scenarioAdversarial() {
  const statePath = tmpState4
  const host = createFakeHost({ config: { statePath, logDir: path.dirname(statePath) } })
  startPlugin(host, { statePath, logDir: path.dirname(statePath) })
  const command = host.commands.get('improve')
  await command.handler({ agent: host.agent, rawInput: 'tier extreme' })
  await command.handler({ agent: host.agent, rawInput: 'adversarial on' })

  const text = host.sectionText()
  assert.ok(text.includes('反例') && text.includes('代价'), '动手前应有反例与代价审查')
  assert.ok(text.includes('偏离'), '交付前应审查是否偏离最初目标')
  assert.ok(text.includes('每轮'), '循环模式应每轮审查')
  assert.ok(!text.includes('长篇复述') === false, '明确要求不要长篇复述')

  // 审查不得阻塞工具调用：pre-execute 仍返回 allow。
  let decision = null
  for (const handler of host.listeners.get('tools/pre-execute') ?? []) {
    decision = await handler({ agent: host.agent }, () => Promise.resolve({ kind: 'allow' }))
  }
  assert.equal(decision?.kind, 'allow', '对抗审查不得阻塞工具调用')
  return { hasCounterExample: true, hasDriftReview: true, toolGate: decision?.kind }
}

// ═══════════════════════════════════════ 5. 路线校准（第 N 轮附近）

async function scenarioGoalCheck() {
  const statePath = makeSessionStateFile()
  const host = createFakeHost({ config: { statePath, logDir: path.dirname(statePath) } })
  startPlugin(host, { statePath, logDir: path.dirname(statePath), goalCheckInterval: 3 })
  for (let turn = 1; turn <= 6; turn += 1) {
    await runTurn(host, { turn, tool: 'pwsh' })
  }
  const logs = readLog(path.dirname(statePath))
  const scheduled = logs.filter((entry) => entry.event === 'route.goal-check.scheduled')
  assert.ok(scheduled.length >= 2, `第 3/6 轮应安排目标对照，实际 ${scheduled.length} 次`)
  assert.deepEqual(
    scheduled.map((entry) => entry.data?.turn ?? entry.turn),
    [3, 6],
    '目标对照应发生在第 3、6 轮，而不是任务结束时',
  )
  const goalFollowups = host.followups.filter((text) => text.includes('目标对照'))
  assert.equal(goalFollowups.length, 2, '应在第 3、6 轮结束后注入目标对照提示')
  assert.ok(goalFollowups[0].includes('一到两行'), '目标对照要求简短回答，不要长篇')
  return { turns: scheduled.map((entry) => entry.data?.turn ?? entry.turn) }
}

// ═══════════════════════════════════════ 6. 降级说明

async function scenarioDegrade() {
  const statePath = makeSessionStateFile()
  const host = createFakeHost({ config: { statePath, logDir: path.dirname(statePath) }, withStreamHook: false })
  startPlugin(host, { statePath, logDir: path.dirname(statePath) })
  for (let turn = 1; turn <= 4; turn += 1) {
    // 降级路径：没有 llm/stream 时，宿主仍会广播 assistant/message（已组装好的回复）。
    host.emitSessionEvent('turn/start', { turn })
    host.emitSessionEvent('step/start', { turn, step: 1 })
    host.emitSessionEvent('assistant/message', {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '好' }] },
    })
    host.emitSessionEvent('step/end', { turn, step: 1 })
    host.emitSessionEvent('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const logs = readLog(path.dirname(statePath))
  const degrade = logs.filter((entry) => entry.event === 'degrade.no-stream-hook')
  assert.ok(degrade.length >= 1, '缺少流式拦截点时必须明确报告降级，而不是静默失效')
  assert.ok(String(degrade[0].message).includes('降级'), '降级日志应说明退化后的行为')
  // 降级后仍然要有兜底：轮次后检测仍能标记并注入纠正。
  assert.ok(host.followups.length >= 1, '降级路径仍应能注入纠正提示')
  return { degradeLogged: degrade.length, fallbackFollowups: host.followups.length }
}

// ═══════════════════════════════════════ 7. 推理尾部重复 → 流内打断

async function scenarioStreamInterrupt() {
  const statePath = makeSessionStateFile()
  const host = createFakeHost({ config: { statePath, logDir: path.dirname(statePath) } })
  startPlugin(host, { statePath, logDir: path.dirname(statePath) })
  const repeated =
    '我需要仔细考虑这个问题。首先确认插件的生命周期，其次确认 UI 的挂载点，最后再决定注册顺序。' +
    '目前看来最关键的是 hook 的返回值必须保持 decision 的形状，否则下游会抛出 TypeError。' +
    '所以我应该先读源码再动手，读源码再动手，读源码再动手。'

  // 第一轮：先累计一次空转（无文本、无工具，仅重复推理）。
  await runTurn(host, { turn: 1, reasoning: repeated })
  // 第二轮：同样的推理再次出现 → 应触发流内掐断。
  const chunks = reasoningChunks(repeated)
  host.emitSessionEvent('turn/start', { turn: 2 })
  host.emitSessionEvent('step/start', { turn: 2, step: 1 })
  const produced = await host.runStep(chunks, { turn: 2, step: 1 })
  host.emitSessionEvent('step/end', { turn: 2, step: 1 })
  host.emitSessionEvent('turn/end', { turn: 2, reason: { kind: 'completed' } })

  const logs = readLog(path.dirname(statePath))
  const streamInterrupts = logs.filter((entry) => entry.event === 'idle.interrupt.stream')
  assert.ok(streamInterrupts.length >= 1, '重复推理应触发流内打断')
  const last = produced[produced.length - 1]
  assert.equal(last?.type, 'finish', '流内打断应以 finish 收尾')
  assert.equal(last?.reason?.kind, 'stop', 'finish 应为 stop，不得伪造 error')
  assert.ok(host.followups.length >= 1, '流内打断后仍要让任务继续')
  return { streamInterrupts: streamInterrupts.length, produced: produced.length, total: chunks.length }
}

// ═══════════════════════════════════════ 8. UI 接线：投影 + 命令

async function scenarioUiWiring() {
  const statePath = makeSessionStateFile()
  const host = createFakeHost({
    config: { statePath, logDir: path.dirname(statePath) },
    withProjections: true,
  })
  startPlugin(host, { statePath, logDir: path.dirname(statePath) })

  assert.equal(host.projections.length, 1, '应注册一个档位投影')
  const unit = host.projections[0]
  assert.equal(unit.key, 'dshImproveThink', '投影 key 必须与 client.js 一致')
  assert.equal(unit.stateVersion, 1, 'stateVersion 必须是非负整数')
  assert.ok(unit.wire?.viewSchema, '必须声明 wire.viewSchema，否则客户端读不到')
  assert.ok(unit.stateSchema, '必须声明 stateSchema，否则 checkpoint 恢复会失败')

  host.emitSessionEvent('turn/start', { turn: 1 })
  const state = unit.init({ id: 'session-selftest' })
  const next = unit.apply(state, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
  const view = unit.wire.view(next)
  assert.equal(view.sessionId, 'session-selftest')
  assert.equal(view.tier, 'normal', '默认档位应为常规')
  assert.equal(view.idleGuard, true, '默认空转守护应为开')
  assert.equal(view.firstTurnFast, true, '默认首轮快跳应为开')
  assert.equal(view.adversarial, false, '默认对抗应为关')
  assert.equal(typeof view.capabilities?.streamIntercept, 'boolean')

  // UI 点击 → session command → 状态变化 → 投影随之变化。
  const command = host.commands.get('improve')
  assert.ok(command, '必须注册 improve 命令供 UI 写回')
  const result = command.handler({
    agent: { id: 'session-selftest', session: { id: 'session-selftest' } },
    rawInput: 'tier extreme',
    attachments: [],
    signal: { aborted: false },
  })
  assert.equal(result.kind, 'success', `命令应成功：${result.text}`)
  const after = unit.wire.view(unit.apply(next, { type: 'config.patch', data: {}, seq: 2 }))
  assert.equal(after.tier, 'extreme', '切换档位后投影应反映新档位')

  // status 子命令是排障入口，必须能读。
  const status = command.handler({
    agent: { id: 'session-selftest', session: { id: 'session-selftest' } },
    rawInput: 'status',
    attachments: [],
    signal: { aborted: false },
  })
  assert.equal(status.kind, 'success')
  assert.ok(status.text.includes('思考档'), 'status 应回显思考档')
  assert.ok(status.text.includes('空转守护'), 'status 应回显空转守护')

  return { commands: host.commands.size, tierAfter: after.tier }
}

// ═══════════════════════════════════════ 9. 面向模型的工具 + 幽灵步 + 能力补记

async function scenarioAgentTool() {
  const statePath = makeSessionStateFile()
  const logDir = path.dirname(statePath)
  const host = createFakeHost({ config: { statePath, logDir }, withTools: true })
  startPlugin(host, { statePath, logDir })
  const call = (args) => host.tools.get('dsh_improve').execute(args, { agent: host.agent })

  assert.equal(host.tools.size, 1, '应注册一个 dsh_improve 工具')
  const tool = host.tools.get('dsh_improve')
  assert.ok(tool.parameters?.properties?.action, '工具参数应声明 action')
  assert.ok(tool.output?.schema, '工具必须声明 output.schema')

  // 与 /improve 命令同源：同一个动作语义一致。
  const switched = await call({ action: 'tier', value: 'extreme' })
  assert.equal(switched.ok, true, '工具应返回 ok')
  const status = await call({ action: 'status' })
  assert.ok(status.text.includes('极致'), '切档后 status 应回显极致')
  assert.ok(status.text.includes('工具=已注册'), '诊断行应显示工具已注册')
  assert.equal(tool.output.render({}, status)[0]?.type, 'text', '渲染应是文本而非 JSON 墙')

  // 非法输入必须报错（宿主会转成 isError），不能静默成功。
  await assert.rejects(() => call({ action: 'tier', value: 'ultra' }), /normal|strict|extreme/)

  // 幽灵步：插件加载前就开跑的 step 只有 step/end、没有 step/start → 不评估、不记日志。
  host.emitSessionEvent('step/end', { turn: 7, step: 1 })
  host.emitSessionEvent('turn/end', { turn: 7, reason: { kind: 'completed' } })
  const early = readLog(logDir)
  assert.equal(
    early.filter((entry) => entry.event === 'idle.observe' || entry.event === 'idle.interrupt').length,
    0,
    '没有 step/start 的步不应被评估',
  )

  // 能力补记：注入点收尾（或 1.5s 兜底）后写 capabilities.ready，避免日志永远写着 false。
  // 这类全局事件写在 global.jsonl；logger 把 data 字段摊平到记录顶层。
  await new Promise((resolve) => setTimeout(resolve, 1700))
  const ready = readLog(logDir, 'global').filter((entry) => entry.event === 'capabilities.ready')
  assert.equal(ready.length, 1, '应补记一次最终能力')
  assert.equal(ready[0].tools, true, '补记时应已包含 tools 能力')
  assert.equal(ready[0].projection, false, '没有 sessionProjections 时应如实记为 false')

  return { toolCount: host.tools.size, readyReason: ready[0].reason }
}

// ═══════════════════════════════════════ 执行

const report = {}
report.stagnation = await scenarioStagnation()
check('1. 空转模拟：observe 只记录；interrupt 打断并注入纠正提示且任务继续', () => {
  assert.ok(report.stagnation.observed >= 2)
  assert.ok(report.stagnation.interrupts >= 1)
  assert.ok(report.stagnation.followups >= 1)
})

report.complex = await scenarioComplexTask()
check('2. 正常复杂任务：多步工具调用不误打断、推理深度不被削弱', () => {
  assert.equal(report.complex.interruptions, 0)
})

report.fastStart = await scenarioFirstTurnFast()
check('3. 首轮快跳：只约束首轮，后续仍可深度推理', () => {
  assert.ok(report.fastStart.firstHasFastStart)
  assert.equal(report.fastStart.laterHasFastStart, false)
})

report.adversarial = await scenarioAdversarial()
check('4. 对抗审查：动手前/交付前简短审查，且不阻塞工具调用', () => {
  assert.ok(report.adversarial.hasCounterExample)
  assert.equal(report.adversarial.toolGate, 'allow')
})

report.goalCheck = await scenarioGoalCheck()
check('5. 路线校准：第 goalCheckInterval 轮附近对照目标', () => {
  assert.deepEqual(report.goalCheck.turns, [3, 6])
})

report.degrade = await scenarioDegrade()
check('6. 降级说明：缺少流式拦截点时明确报告并走兜底', () => {
  assert.ok(report.degrade.degradeLogged >= 1)
})

report.streamInterrupt = await scenarioStreamInterrupt()
check('7. 流内打断：重复推理提前收尾，finish=stop，任务继续', () => {
  assert.ok(report.streamInterrupt.streamInterrupts >= 1)
})

report.uiWiring = await scenarioUiWiring()
check('8. UI 接线：投影可读、命令可写、两者一致', () => {
  assert.equal(report.uiWiring.tierAfter, 'extreme')
})

report.agentTool = await scenarioAgentTool()
check('9. 工具/幽灵步/能力补记：模型可读可写、无 step/start 不评估、能力如实补记', () => {
  assert.equal(report.agentTool.toolCount, 1)
})

check('10. 配置 schema：宿主缺 schemastery 时插件仍可用（降级而非崩溃）', () => {
  const ok = Config === undefined || (typeof Config === 'object' && Config !== null && typeof Config.parse === 'function')
  assert.ok(ok, `Config 必须要么是 schema 要么是 undefined，实际 ${typeof Config}`)
  // 有 schema 的环境（DSH profile）里每个字段都必须是 volatile：
  // 非 volatile 字段不会出现在插件设置页，用户就看不到任何设置项。
  if (Config !== undefined) {
    const fields = Config.dict ?? {}
    const missing = Object.entries(fields)
      .filter(([, child]) => child?.meta?.volatile !== true)
      .map(([key]) => key)
    assert.deepEqual(missing, [], `这些字段缺少 .volatile()，不会出现在插件设置页：${missing.join(', ')}`)
  }
})

report.liveSettings = await scenarioLiveSettings()
check('11. 设置热读取：volatile 取值器可读、保存后新会话立即生效、会话覆盖优先', () => {
  assert.equal(report.liveSettings.tierFromSettings, 'strict')
  assert.equal(report.liveSettings.tierAfterSave, 'extreme')
  assert.equal(report.liveSettings.overrideKept, 'normal')
})

// ═══════════════════════════════════════ 11. 设置热读取：volatile 取值器 + 会话覆盖优先

async function scenarioLiveSettings() {
  const statePath = makeSessionStateFile()
  const logDir = path.dirname(statePath)
  // 模拟 DSH 的 volatile 字段：每个字段是取值器，插件页保存 = 换掉它返回的值。
  // 插件不在加载时冻结配置，所以同一个插件实例应该立刻读到新值。
  const live = { tier: 'strict', goalCheckInterval: 7, statePath, logDir }
  const config = Object.fromEntries(Object.keys(live).map((key) => [key, { get: () => live[key] }]))

  const host = createFakeHost({ config, withCommands: true, withProjections: true })
  startPlugin(host, config)
  const command = host.commands.get('improve')
  assert.ok(command, '必须注册 improve 命令')

  const ask = (sessionId, rawInput) =>
    command.handler({
      agent: { id: sessionId, session: { id: sessionId } },
      rawInput,
      attachments: [],
      signal: { aborted: false },
    })

  const fresh = ask('session-live-a', 'status')
  assert.equal(fresh.kind, 'success', `status 应成功：${fresh.text}`)
  assert.ok(fresh.text.includes('严格'), `新会话应读到设置里的 strict：${fresh.text}`)
  assert.ok(fresh.text.includes('goalCheckInterval=7'), `新会话应读到 goalCheckInterval=7：${fresh.text}`)

  // 插件页保存：值原地改变，不重启插件，新会话立刻用新默认值。
  live.tier = 'extreme'
  const afterSave = ask('session-live-b', 'status')
  assert.ok(afterSave.text.includes('极致'), `保存设置后新会话应立刻生效：${afterSave.text}`)

  // 会话覆盖优先：显式改过档位的会话不被后续默认值覆盖。
  const override = ask('session-live-a', 'tier normal')
  assert.ok(override.text.includes('常规'), `显式切换应成功：${override.text}`)
  live.tier = 'strict'
  const stillOverridden = ask('session-live-a', 'status')
  assert.ok(stillOverridden.text.includes('常规'), `会话覆盖应优先于默认值：${stillOverridden.text}`)

  // 没有 settings 服务时，status 必须明说"无法查询"，不能假装设置页可用。
  assert.ok(
    stillOverridden.text.includes('设置页：无法查询'),
    `缺少 settings 服务时应如实报告：${stillOverridden.text}`,
  )

  // 有 settings 服务且确实服务了本插件 → 报告"已开放"。
  const servedHost = createFakeHost({
    config,
    withCommands: true,
    settingsRows: [{ ns: 'include:dsh-improve-think', value: { tier: 'strict', idleGuard: true } }],
  })
  startPlugin(servedHost, config)
  const served = servedHost.commands.get('improve').handler({
    agent: { id: 'session-live-c', session: { id: 'session-live-c' } },
    rawInput: 'status',
    attachments: [],
    signal: { aborted: false },
  })
  assert.ok(served.text.includes('设置页：已开放'), `服务了本插件时应报告已开放：${served.text}`)
  assert.ok(served.text.includes('include:dsh-improve-think'), `应回显实际 namespace：${served.text}`)

  // 服务了其他插件、没服务本插件（例如字段忘标 .volatile()）→ 明说未开放并给原因。
  const missingHost = createFakeHost({
    config,
    withCommands: true,
    settingsRows: [{ ns: 'include:other-plugin', value: { a: 1 } }],
  })
  startPlugin(missingHost, config)
  const missing = missingHost.commands.get('improve').handler({
    agent: { id: 'session-live-d', session: { id: 'session-live-d' } },
    rawInput: 'status',
    attachments: [],
    signal: { aborted: false },
  })
  assert.ok(missing.text.includes('设置页：未开放'), `未服务本插件时应报告未开放：${missing.text}`)
  assert.ok(missing.text.includes('.volatile()'), `应给出可操作的排查提示：${missing.text}`)

  return { tierFromSettings: 'strict', tierAfterSave: 'extreme', overrideKept: 'normal' }
}


const failed = results.filter((item) => !item.ok)
console.log('')
console.log(`自测完成：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(` - ${item.name}: ${item.error?.message ?? item.error}`)
  process.exitCode = 1
}
console.log('证据摘要：', JSON.stringify(report, null, 2))
