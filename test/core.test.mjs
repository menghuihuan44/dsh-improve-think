import test from 'node:test'
import assert from 'node:assert/strict'

import {
  conclusionSignature,
  isFillerOnly,
  planItemCount,
  tailSimilarity,
  normalizeText,
} from '../lib/core/text.js'
import { DEFAULTS, normalizeConfig, pickPublicConfig } from '../lib/core/config.js'
import {
  ACTION,
  VERDICT,
  beginStep,
  correctionPrompt,
  createSessionState,
  createStepObservation,
  endTurn,
  evaluateStep,
  shouldAbortMidStream,
  snapshot,
} from '../lib/core/stagnation.js'
import {
  buildSectionText,
  firstTurnFastText,
  goalCheckText,
  needsTierBlocks,
  preActionText,
  postDeliveryText,
  routeCalibrationText,
} from '../lib/core/prompts.js'

// ---------------------------------------------------------------- text.js

test('normalizeText 折掉空白与标点（用于比较，不保留可读空格）', () => {
  assert.equal(normalizeText('  a\n\n  b\tc  '), 'abc')
  assert.equal(normalizeText('结论：先读文件，再动手。'), '结论先读文件再动手')
  assert.equal(normalizeText(null), '')
})

test('isFillerOnly 只认短空话', () => {
  assert.equal(isFillerOnly('好的'), true)
  assert.equal(isFillerOnly('好，做'), true)
  assert.equal(isFillerOnly('执行'), true)
  assert.equal(isFillerOnly('好，我来执行下一步：先读 package.json 再改 build 脚本。'), false)
  assert.equal(isFillerOnly('这是第十九项检查的结论'), false)
})

/** 一段足够长的、模拟真实推理的文本（中文，>80 字，保证越过最小比较长度）。 */
const LONG_REASONING =
  '我需要先把插件的生命周期理清楚：apply 在插件加载时执行，agent/created 每个子代理都会触发一次，' +
  '而 systemPrompt.section 返回的是注销函数，必须挂到 ctx.effect 里才能随着插件卸载而清理。' +
  '其次要考虑流式拦截的边界——任何误伤都比漏拦更糟，所以只在尾部高度重复时才动手。'

const UNRELATED_TEXT =
  '前端档位条放在输入框下方的 dock 槽位里，状态通过宿主半边的 JSON-RPC 桥回传，' +
  '并且每个会话各自持久化一份，避免重启后回到默认值。'

test('tailSimilarity：完全相同接近 1，不同内容接近 0', () => {
  assert.ok(tailSimilarity(LONG_REASONING, LONG_REASONING) > 0.99)
  assert.ok(tailSimilarity(LONG_REASONING, UNRELATED_TEXT) < 0.3)
})

test('conclusionSignature 对同一结论稳定', () => {
  const a = conclusionSignature('结论：应该先读文件再动手。')
  const b = conclusionSignature('结论：应该先读文件再动手！')
  assert.equal(a, b)
})

test('planItemCount 识别多步计划', () => {
  assert.equal(planItemCount('1. 读文件\n2. 改代码\n3. 跑测试'), 3)
  assert.equal(planItemCount('- 读文件\n- 改代码'), 2)
  assert.equal(planItemCount('没有计划'), 0)
})

// -------------------------------------------------------------- config.js

test('normalizeConfig 收敛越界值', () => {
  const config = normalizeConfig({
    stagnationCount: 999,
    reasoningSimilarityThreshold: 3,
    goalCheckInterval: 0,
    tier: 'unknown',
    idleGuardAction: 'explode',
  })
  assert.equal(config.stagnationCount, 20)
  assert.equal(config.reasoningSimilarityThreshold, 0.98)
  assert.equal(config.goalCheckInterval, 1)
  assert.equal(config.tier, DEFAULTS.tier)
  assert.equal(config.idleGuardAction, DEFAULTS.idleGuardAction)
})

test('默认值符合需求（空转守护开、首轮快跳开、interrupt 模式）', () => {
  const config = normalizeConfig({})
  assert.equal(config.idleGuard, true)
  assert.equal(config.firstTurnFast, true)
  assert.equal(config.idleGuardAction, 'interrupt')
  assert.equal(config.stagnationCount, 3)
  assert.equal(config.reasoningSimilarityThreshold, 0.8)
  assert.equal(config.goalCheckInterval, 5)
})

test('pickPublicConfig 只暴露公开字段', () => {
  const picked = pickPublicConfig({ ...DEFAULTS, statePath: 'C:/tmp/x.json', logDir: 'C:/tmp' })
  assert.ok('tier' in picked)
  assert.ok(!('statePath' in picked))
  assert.ok(!('logDir' in picked))
})

// ----------------------------------------------------------- stagnation.js

function stepNoAction(state, text, reasoning = '') {
  beginStep(state)
  return evaluateStep(state, { ...createStepObservation(), text, reasoning })
}

test('空转模拟：连续"好/做/执行"达到阈值后触发 interrupt 并给纠正提示', () => {
  const state = createSessionState({ stagnationCount: 3, idleGuardAction: 'interrupt' })
  const results = []
  for (const text of ['好', '做', '执行', '好']) results.push(stepNoAction(state, text))
  assert.equal(results[0].verdict, VERDICT.NON_PROGRESS)
  assert.equal(results[0].action, ACTION.OBSERVE)
  assert.equal(results[1].action, ACTION.OBSERVE)
  assert.equal(results[2].action, ACTION.INTERRUPT)
  assert.ok(results[2].correction.includes('没有产生新进展'))
  assert.equal(results[3].verdict, VERDICT.NON_PROGRESS)
  assert.equal(state.stats.interrupted, 1)
  assert.ok(state.pendingCorrection, '应留下待注入的纠正提示')
})

test('observe 模式只记录，从不打断', () => {
  const state = createSessionState({ stagnationCount: 3, idleGuardAction: 'observe' })
  for (let i = 0; i < 12; i += 1) stepNoAction(state, '好')
  assert.equal(state.stats.interrupted, 0)
  assert.ok(state.stats.observed > 0)
  assert.equal(state.pendingCorrection, null)
})

test('正常复杂任务不会被误打断', () => {
  const state = createSessionState({})
  const observation = () => ({ ...createStepObservation(), toolCalls: 1, text: 'read foo' })
  let previousText = ''
  for (let i = 0; i < 30; i += 1) {
    beginStep(state)
    previousText += ` 新增内容 ${i}`
    const result = evaluateStep(state, { ...observation(), text: `读取文件 ${i} 并修改第 ${i} 行` })
    assert.equal(result.verdict, VERDICT.PROGRESS)
    assert.equal(result.action, ACTION.NONE)
  }
  assert.equal(state.streak, 0)
  assert.equal(state.stats.interrupted, 0)
  assert.ok(previousText.length > 0)
})

test('深度探索（长推理 + 无工具 + 新内容）放行', () => {
  const state = createSessionState({})
  const long =
    '这里的难点在于 hook 的执行顺序：如果 pre-step 里修改 messages，需要保持 startsRequestSeries 字段不变，' +
    '否则下游会把这次调用当成新的请求序列。另一种方案是把纠正提示塞到 user 消息中间，但会破坏配对结构。'
  beginStep(state)
  const result = evaluateStep(state, { ...createStepObservation(), reasoning: long, text: '结论：选择在 pre-step 注入。' })
  assert.equal(result.verdict, VERDICT.PROGRESS)
  assert.equal(result.action, ACTION.NONE)
})

test('推理尾部重复且无动作 → NON_PROGRESS', () => {
  const state = createSessionState({ stagnationCount: 2 })
  beginStep(state)
  const first = evaluateStep(state, { ...createStepObservation(), reasoning: LONG_REASONING, text: '' })
  // 第一步只是"只有推理没有动作"，没有重复证据 → 宁可放行（inconclusive-release）。
  assert.equal(first.verdict, VERDICT.PROGRESS)
  assert.equal(first.reason, 'inconclusive-release')
  beginStep(state)
  const second = evaluateStep(state, { ...createStepObservation(), reasoning: LONG_REASONING, text: '' })
  assert.equal(second.verdict, VERDICT.NON_PROGRESS)
  assert.equal(second.signals.repeatingReasoning, true)
})

test('流内拦截：没有基线时不掐，有基线且重复时掐', () => {
  const state = createSessionState({ minReasoningChars: 40 })
  state.lastReasoning = LONG_REASONING
  // 还没有任何已完成的 step → 没有对照基线，放行。
  assert.equal(shouldAbortMidStream(state, LONG_REASONING).abort, false)
  assert.equal(shouldAbortMidStream(state, LONG_REASONING).reason, 'no-baseline')
  // 有了一个基线的 step 后，同样的推理尾部重复 → 掐断。
  state.recent.push({ verdict: VERDICT.PROGRESS, text: '', reasoning: LONG_REASONING })
  const decision = shouldAbortMidStream(state, LONG_REASONING)
  assert.equal(decision.abort, true)
  assert.equal(decision.reason, 'repetitive-reasoning')
})

test('流内拦截：有工具调用一律不掐', () => {
  const state = createSessionState({})
  state.streak = 3
  state.lastReasoning = 'x'.repeat(200)
  const decision = shouldAbortMidStream(state, 'x'.repeat(200), { hasToolCall: true })
  assert.equal(decision.abort, false)
  assert.equal(decision.reason, 'tool-call-in-progress')
})

test('流内拦截：关掉守护后永不掐', () => {
  const state = createSessionState({ idleGuard: false })
  state.streak = 5
  state.lastReasoning = 'x'.repeat(200)
  assert.equal(shouldAbortMidStream(state, 'x'.repeat(200)).abort, false)
})

test('工具调用/代码变更优先视为进展', () => {
  const state = createSessionState({ stagnationCount: 2 })
  beginStep(state)
  evaluateStep(state, { ...createStepObservation(), text: '好' })
  beginStep(state)
  const result = evaluateStep(state, { ...createStepObservation(), text: '好', codeChanges: 1 })
  assert.equal(result.verdict, VERDICT.PROGRESS)
  assert.equal(state.streak, 0)
})

test('出错步骤不算空转（证据不足）', () => {
  const state = createSessionState({ stagnationCount: 2 })
  beginStep(state)
  const result = evaluateStep(state, { ...createStepObservation(), text: '好', error: new Error('boom'), finishedNormally: false })
  assert.equal(result.verdict, VERDICT.UNKNOWN)
  assert.equal(state.streak, 0)
})

test('轮次结束按 goalCheckInterval 安排目标对照', () => {
  const state = createSessionState({ goalCheckInterval: 5 })
  const marks = []
  for (let i = 0; i < 12; i += 1) {
    beginStep(state, { newTurn: true })
    evaluateStep(state, { ...createStepObservation(), toolCalls: 1, text: `step ${i}` })
    endTurn(state)
    if (state.pendingGoalCheck) {
      marks.push(state.turn)
      state.pendingGoalCheck = null
    }
  }
  assert.deepEqual(marks, [5, 10])
  assert.equal(state.stats.goalChecks, 2)
})

test('snapshot 可序列化且不含函数', () => {
  const state = createSessionState({})
  beginStep(state)
  evaluateStep(state, { ...createStepObservation(), text: '好' })
  const snap = snapshot(state)
  assert.equal(JSON.parse(JSON.stringify(snap)).streak, snap.streak)
  assert.ok(Array.isArray(snap.recent))
})

test('correctionPrompt 明确不否定深度探索', () => {
  const text = correctionPrompt()
  assert.ok(text.includes('下一步可执行动作'))
  assert.ok(text.includes('不拦深度探索'))
})

// -------------------------------------------------------------- prompts.js

test('常规档不注入任何确认步骤', () => {
  assert.equal(preActionText('normal', false), '')
  assert.equal(postDeliveryText('normal', false), '')
  assert.equal(needsTierBlocks('normal', false), false)
})

test('严格档：动手前三行 + 交付前自检，且要求简短', () => {
  const pre = preActionText('strict', false)
  assert.ok(pre.includes('目标'))
  assert.ok(pre.includes('假设'))
  assert.ok(pre.includes('回滚'))
  assert.ok(pre.includes('三行'))
  const post = postDeliveryText('strict', false)
  assert.ok(post.includes('自我检查'))
  assert.ok(post.includes('不要长篇'))
})

test('极致档 + 对抗：反例与代价、偏离审查、循环每轮审查', () => {
  const pre = preActionText('extreme', true)
  assert.ok(pre.includes('反例'))
  assert.ok(pre.includes('代价'))
  const post = postDeliveryText('extreme', true)
  assert.ok(post.includes('偏离'))
  assert.ok(post.includes('每轮'))
  assert.equal(needsTierBlocks('extreme', true), true)
})

test('路线校准包含 SHOULD / CAN / MUST NOT / SHOULD NOT', () => {
  const text = routeCalibrationText({ goalCheckInterval: 7 })
  for (const keyword of ['SHOULD', 'CAN', 'MUST NOT', 'SHOULD NOT']) assert.ok(text.includes(keyword))
  assert.ok(text.includes('7 轮'))
  assert.ok(text.includes('不拦深度探索'))
})

test('首轮快跳只提首轮，且承诺后续仍可深度推理', () => {
  const text = firstTurnFastText()
  assert.ok(text.includes('首轮'))
  assert.ok(text.includes('深度推理'))
})

test('buildSectionText 首轮含快跳，非首轮不含', () => {
  const config = normalizeConfig({ tier: 'strict', firstTurnFast: true })
  assert.ok(buildSectionText({ config, isFirstTurn: true }).includes('首轮快跳'))
  assert.ok(!buildSectionText({ config, isFirstTurn: false }).includes('首轮快跳'))
})

test('goalCheckText 要求一两行回答，不要求长篇', () => {
  const text = goalCheckText(5, 5)
  assert.ok(text.includes('第 5 轮'))
  assert.ok(text.includes('一到两行'))
})
