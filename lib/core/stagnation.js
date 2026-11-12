/**
 * 空转检测状态机（纯逻辑，无 DSH 依赖）。
 *
 * 核心命题（见 DESIGN.md §4）：只拦"反复无进展"，不拦"想得深"。
 * 所以判定的第一原则是：**任何有实质动作的步骤一律放行**，只有"没动作 + 重复"才累计停滞。
 *
 * 观测单位是 step（一次 assistant 模型调用），累计单位是 session。
 */

import { DEFAULTS, normalizeConfig } from './config.js'
import {
  conclusionSignature,
  isFillerOnly,
  normalizedLength,
  planItemCount,
  summarize,
  tailSimilarity,
} from './text.js'

export const VERDICT = Object.freeze({
  /** 有实质进展：工具调用、代码变更、计划增量、或新内容。 */
  PROGRESS: 'progress',
  /** 明确的空转：空话短句 / 结论复发 / 推理尾部高相似且无新内容。 */
  NON_PROGRESS: 'non-progress',
  /** 证据不足（例如该适配器不流式输出推理）：只记录，永不打断。 */
  UNKNOWN: 'unknown',
})

export const ACTION = Object.freeze({
  NONE: 'none',
  OBSERVE: 'observe',
  INTERRUPT: 'interrupt',
})

/** 结论历史保留条数，太多会误伤正常发散。 */
const CONCLUSION_HISTORY = 4
/** 观测历史保留步数，供 UI 与日志回显。 */
const OBSERVATION_HISTORY = 12

export function createSessionState(rawConfig = {}) {
  return {
    config: normalizeConfig(rawConfig),
    /** 已完成的轮次（turn）数。 */
    turn: 0,
    /** 当前 turn 内的 assistant 步骤序号。 */
    step: 0,
    /** 连续"明确空转"步数，命中即清零。 */
    streak: 0,
    /** 连续"证据不足"步数：只用于 UI 提示，不触发打断。 */
    unknownStreak: 0,
    /** 上一步的推理全文，用于尾部相似度。 */
    lastReasoning: '',
    /** 上一步的结论签名。 */
    lastConclusion: '',
    /** 最近若干结论签名。 */
    conclusions: [],
    /** 上一步的计划条目数，用于检测计划增量。 */
    lastPlanItems: 0,
    /** 本步内已发生的打断次数。 */
    interruptsThisStep: 0,
    /** 最近一次打断所在 step，用于冷却。 */
    lastInterruptStep: -1,
    /** 待注入的纠正提示（由 pre-step 消费）。 */
    pendingCorrection: null,
    /** 待执行的目标对照（由轮次结束设置，由下一轮 pre-step 消费）。 */
    pendingGoalCheck: null,
    /** 最近一次目标对照所在 turn。 */
    lastGoalCheckTurn: 0,
    /** UI 用的实时标记。 */
    marked: false,
    markedAt: null,
    markReason: '',
    /** 本 turn 是否已有工具调用。 */
    toolCallsThisTurn: 0,
    /** 观测历史。 */
    recent: [],
    /** 被打断/观察的累计计数，用于复盘。 */
    stats: { observed: 0, interrupted: 0, goalChecks: 0 },
  }
}

export function createStepObservation() {
  return {
    reasoning: '',
    text: '',
    toolCalls: 0,
    codeChanges: 0,
    finishedNormally: true,
    error: null,
  }
}

function pushObservation(state, record) {
  state.recent.push(record)
  if (state.recent.length > OBSERVATION_HISTORY) state.recent.shift()
}

function pushConclusion(state, signature) {
  if (!signature) return
  state.conclusions.push(signature)
  while (state.conclusions.length > CONCLUSION_HISTORY) state.conclusions.shift()
  state.lastConclusion = signature
}

/**
 * 在流式过程中判断"该不该立刻掐断"。
 *
 * 只在**明确的重复**上返回 true，且必须满足：
 * 1) 本步已有足够长的推理文本（否则信息不足）；
 * 2) 与上一步推理尾部相似度达到阈值；
 * 3) 本步还没有任何工具调用（有工具调用就说明在干活）；
 * 4) 上一步已经是空转（streak 已累计），避免"第一步就掐"。
 *
 * 一旦返回 true，调用方应设置 state.interruptsThisStep++ 并写入纠正提示。
 */
export function shouldAbortMidStream(state, partialReasoning, options = {}) {
  const config = state.config ?? DEFAULTS
  if (!config.idleGuard) return { abort: false, reason: 'guard-off' }
  if (options.hasToolCall) return { abort: false, reason: 'tool-call-in-progress' }
  if (state.interruptsThisStep >= config.maxInterruptsPerStep) {
    return { abort: false, reason: 'step-interrupt-quota' }
  }
  const length = normalizedLength(partialReasoning)
  if (length < config.minReasoningChars) return { abort: false, reason: 'reasoning-too-short' }
  const threshold = config.reasoningSimilarityThreshold
  const similarity = tailSimilarity(state.lastReasoning, partialReasoning)
  const repeatConclusion =
    Boolean(state.lastConclusion) && conclusionSignature(partialReasoning) === state.lastConclusion
  const saturated = similarity >= threshold || repeatConclusion
  if (!saturated) return { abort: false, reason: 'not-repetitive', similarity }
  // 保守边界：至少要有一个已经完成的 step 作为对照，第一步（会话刚开）绝不掐。
  if (state.recent.length < 1) return { abort: false, reason: 'no-baseline', similarity }
  // 同一结论已出现多次时也要有基线，避免"第一次就重复自己"被误判。
  if (repeatConclusion && state.conclusions.length < 1) return { abort: false, reason: 'no-conclusion-baseline', similarity }
  return { abort: true, reason: 'repetitive-reasoning', similarity }
}

/**
 * 评估一个已完成的 step。
 *
 * @param {object} state createSessionState() 的返回值
 * @param {object} observation createStepObservation() 采集到的结果
 * @returns {{verdict: string, action: string, streak: number, signals: object, reason: string, correction: string|null}}
 */
export function evaluateStep(state, observation) {
  const config = state.config ?? DEFAULTS
  const reasoning = String(observation?.reasoning ?? '')
  const text = String(observation?.text ?? '')
  const toolCalls = Math.max(0, Number(observation?.toolCalls) || 0)
  const codeChanges = Math.max(0, Number(observation?.codeChanges) || 0)
  const failed = Boolean(observation?.error) || observation?.finishedNormally === false

  const similarity = tailSimilarity(state.lastReasoning, reasoning)
  const filler = isFillerOnly(text)
  const signature = conclusionSignature(text)
  const repeatedConclusion =
    Boolean(signature) && state.conclusions.length > 0 && state.conclusions.includes(signature)
  const planItems = planItemCount(text)
  const planDelta = planItems > state.lastPlanItems
  const novelText = normalizedLength(text) >= 40 && !repeatedConclusion
  const enoughReasoning =
    normalizedLength(reasoning) >= config.minReasoningChars ||
    normalizedLength(state.lastReasoning) >= config.minReasoningChars
  const repeatingReasoning = enoughReasoning && similarity >= config.reasoningSimilarityThreshold
  const acted = toolCalls > 0 || codeChanges > 0

  const signals = {
    toolCalls,
    codeChanges,
    filler,
    repeatedConclusion,
    repeatingReasoning,
    similarity,
    planDelta,
    planItems,
    reasoningChars: normalizedLength(reasoning),
    textChars: normalizedLength(text),
    novelText,
  }

  let verdict
  let reason
  if (failed) {
    // 出错/被用户中断的步骤不算空转：归入证据不足，直接放行。
    verdict = VERDICT.UNKNOWN
    reason = 'step-failed'
  } else if (acted || planDelta) {
    verdict = VERDICT.PROGRESS
    reason = acted ? 'tool-or-code-action' : 'plan-delta'
  } else if (novelText && !repeatingReasoning) {
    // 发散/探索：即使推理很长、即使没有工具调用，只要产出是新内容就放行。
    verdict = VERDICT.PROGRESS
    reason = 'novel-content'
  } else if (filler || repeatedConclusion || repeatingReasoning) {
    verdict = VERDICT.NON_PROGRESS
    reason = filler ? 'filler-only' : repeatedConclusion ? 'repeated-conclusion' : 'repetitive-reasoning'
  } else if (signals.reasoningChars === 0 && signals.textChars === 0) {
    verdict = VERDICT.UNKNOWN
    reason = 'no-visible-output'
  } else {
    verdict = VERDICT.PROGRESS
    reason = 'inconclusive-release'
  }

  // ---- 累计 ----
  if (verdict === VERDICT.NON_PROGRESS) {
    state.streak += 1
    state.unknownStreak = 0
  } else if (verdict === VERDICT.UNKNOWN) {
    state.unknownStreak += 1
    // 证据不足不清零，但也不累计：保持"宁可漏拦"。
  } else {
    state.streak = 0
    state.unknownStreak = 0
  }

  pushConclusion(state, signature)
  state.lastReasoning = reasoning
  state.lastPlanItems = Math.max(state.lastPlanItems, planItems)
  state.toolCallsThisTurn += toolCalls

  const record = {
    step: state.step,
    turn: state.turn,
    verdict,
    reason,
    similarity,
    signals,
    textPreview: summarize(text, 80),
    reasoningPreview: summarize(reasoning, 80),
    at: new Date().toISOString(),
  }
  pushObservation(state, record)

  // ---- 决策 ----
  let action = ACTION.NONE
  let correction = null
  if (!config.idleGuard) {
    return { verdict, action, streak: state.streak, signals, reason: `${reason};guard-off`, correction }
  }

  const target = verdict === VERDICT.NON_PROGRESS ? ACTION.INTERRUPT : ACTION.OBSERVE
  const reached = state.streak >= config.stagnationCount
  if (verdict === VERDICT.NON_PROGRESS && reached) {
    const wantInterrupt = config.idleGuardAction === ACTION.INTERRUPT
    const cooldownOk = state.lastInterruptStep < state.step - 1 || state.interruptsThisStep === 0
    if (wantInterrupt && cooldownOk) {
      action = ACTION.INTERRUPT
      correction = correctionPrompt(config)
      state.pendingCorrection = correction
      state.interruptsThisStep += 1
      state.lastInterruptStep = state.step
      state.stats.interrupted += 1
      state.streak = 0
    } else {
      action = ACTION.OBSERVE
      state.stats.observed += 1
    }
  } else if (verdict === VERDICT.NON_PROGRESS || verdict === VERDICT.UNKNOWN) {
    // 未达阈值：先观察并标记，不打断。
    action = ACTION.OBSERVE
    if (verdict === VERDICT.NON_PROGRESS) state.stats.observed += 1
  }

  state.marked = action !== ACTION.NONE
  if (state.marked) {
    state.markedAt = record.at
    state.markReason = `${reason} (streak=${state.streak}, similarity=${similarity})`
  }

  return {
    verdict,
    action,
    streak: state.streak,
    signals,
    reason,
    correction,
    note: target === ACTION.INTERRUPT && action === ACTION.OBSERVE ? 'interrupt-wanted-but-observed' : undefined,
  }
}

/** 纠正提示：短、可执行、且明确不否定深度探索。 */
export function correctionPrompt() {
  return [
    '当前推理没有产生新进展。请回到任务，给出下一步可执行动作或工具调用。',
    '（空转守护只拦"重复且无新进展"，不拦深度探索：需要继续分析就直接分析，只是不要重复同一结论。）',
  ].join('\n')
}

/**
 * 步骤开始时重置本步计数，并进入新的一步。
 * @param {object} state
 * @param {{newTurn?: boolean}} options
 */
export function beginStep(state, options = {}) {
  if (options.newTurn) {
    state.turn += 1
    state.toolCallsThisTurn = 0
    state.lastPlanItems = 0
  }
  state.step += 1
  state.interruptsThisStep = 0
  return state.step
}

/** 轮次结束：安排下一次目标对照。 */
export function endTurn(state) {
  const interval = Math.max(1, Number(state.config?.goalCheckInterval) || DEFAULTS.goalCheckInterval)
  if (state.turn > 0 && state.turn % interval === 0 && state.lastGoalCheckTurn !== state.turn) {
    state.pendingGoalCheck = {
      turn: state.turn,
      at: new Date().toISOString(),
    }
    state.lastGoalCheckTurn = state.turn
    state.stats.goalChecks += 1
  }
  state.marked = false
  return state.pendingGoalCheck
}

/** 供 UI 展示的一份快照（纯数据，可直接序列化）。 */
export function snapshot(state) {
  return {
    turn: state.turn,
    step: state.step,
    streak: state.streak,
    unknownStreak: state.unknownStreak,
    marked: state.marked,
    markedAt: state.markedAt,
    markReason: state.markReason,
    pendingGoalCheck: Boolean(state.pendingGoalCheck),
    stats: { ...state.stats },
    recent: state.recent.map((item) => ({
      step: item.step,
      turn: item.turn,
      verdict: item.verdict,
      reason: item.reason,
      similarity: item.similarity,
      at: item.at,
    })),
  }
}
