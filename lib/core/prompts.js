/**
 * 注入到系统提示词的文本构造器（纯函数）。
 *
 * 设计约束（见 DESIGN.md §5）：
 * - 用 SHOULD / CAN / MUST NOT / SHOULD NOT 组织，是软规范；
 * - 明确"空转守护只拦重复无进展，不拦深度探索"，避免模型畏缩；
 * - 只在需要时插入，常规档不增加任何确认步骤，保持提示词轻量。
 */

import { DEFAULTS } from './config.js'

export const SECTION_NAME = 'dsh-improve-think/route-calibration'

/** 路线校准（所有档位都注入，因为它是防跑偏的软规范，不影响推理深度）。 */
export function routeCalibrationText(config = DEFAULTS) {
  const interval = config.goalCheckInterval ?? DEFAULTS.goalCheckInterval
  return [
    '## 路线校准',
    '',
    `- SHOULD：每隔 ${interval} 轮对照用户最初的目标检查当前路线；发现偏移时先停下来说明偏移点（从哪一轮开始、偏离了什么），再纠正，不要默默跑偏。`,
    '- CAN：在目标明确的前提下，大胆重构、大胆扩展、大胆创新；不需要为每一个小改动征求确认。',
    '- MUST NOT：不得在无实质进展的循环中反复输出相同内容；不得用"我在思考"替代可执行动作。',
    '- SHOULD NOT：不得因为"怕想太多"而跳过必要的方案对比和风险检查；不得因为空转守护而不敢进行深度推理。',
    '',
    '空转守护只拦"重复且无新进展"，不拦深度探索：想得久不等于空转，探索性、发散性推理照常进行。',
  ].join('\n')
}

/** 思考档的"动手前"约束。常规档返回空字符串（不增加任何步骤）。 */
export function preActionText(tier, adversarial = false) {
  if (tier === 'strict') {
    return [
      '## 思考档：严格（动手前）',
      '',
      '动手前用不超过三行说明：目标、关键假设、回滚方案。不要长篇复述，写完立刻开始动手。',
    ].join('\n')
  }
  if (tier === 'extreme') {
    const lines = [
      '## 思考档：极致（动手前）',
      '',
      '动手前用不超过五行说明：目标、关键假设、回滚方案。不要长篇复述。',
    ]
    if (adversarial) {
      lines.push('同时用一到两条指出方案的反例与代价（最可能哪里错、错了代价多大），然后开始动手。')
    }
    return lines.join('\n')
  }
  return ''
}

/** 思考档的"交付前"约束。常规档返回空字符串。 */
export function postDeliveryText(tier, adversarial = false) {
  if (tier === 'strict') {
    return [
      '## 思考档：严格（交付前）',
      '',
      '交付前做一次简短自我检查：改了什么、是否跑通、是否漏掉用户要求。检查结果一两句话即可，不要长篇复述。',
    ].join('\n')
  }
  if (tier === 'extreme') {
    const lines = [
      '## 思考档：极致（交付前）',
      '',
      '交付前做一次简短自我检查：改了什么、是否跑通、是否漏掉用户要求。',
    ]
    if (adversarial) {
      lines.push(
        '同时审查改动是否偏离用户最初目标；如果当前处于循环/多轮模式，每轮都做这次审查（每轮一两句，不要长篇）。',
      )
    }
    return lines.join('\n')
  }
  return ''
}

/** 首轮快跳：只作用于首轮的策略提示，不降低后续轮次深度。 */
export function firstTurnFastText() {
  return [
    '## 首轮快跳',
    '',
    '首轮先快速形成可执行计划并开始行动，不要在未读取上下文前闭门造车。',
    '后续轮次仍可进行深度推理；这条约束只针对首轮的起手方式。',
  ].join('\n')
}

/** 目标对照提醒（在 goalCheckInterval 轮之后注入一次）。 */
export function goalCheckText(turn, interval = DEFAULTS.goalCheckInterval) {
  return [
    '## 目标对照',
    '',
    `现在已进行到第 ${turn} 轮（每 ${interval} 轮对照一次）。请用一到两行回答：`,
    '1. 用户最初的目标是什么？',
    '2. 当前路线还在服务这个目标吗？',
    '3. 如果已偏移，偏移点在哪一轮，接下来怎么纠正？',
    '',
    '如果路线正确，回答"路线正确"并继续，不要因此停下任务。',
  ].join('\n')
}

/**
 * 组装最终要注入的 systemPrompt.section 文本。
 *
 * @param {object} params
 * @param {object} params.config 归一化配置
 * @param {boolean} params.isFirstTurn 是否首轮
 * @returns {string}
 */
export function buildSectionText({ config, isFirstTurn = false }) {
  const blocks = [routeCalibrationText(config)]
  if (isFirstTurn && config.firstTurnFast) blocks.push(firstTurnFastText())
  const pre = preActionText(config.tier, config.adversarial)
  if (pre) blocks.push(pre)
  const post = postDeliveryText(config.tier, config.adversarial)
  if (post) blocks.push(post)
  return blocks.join('\n\n')
}

/** 判断某个 tier/adversarial 组合是否需要注入"动手前/交付前"检查。 */
export function needsTierBlocks(tier, adversarial = false) {
  return tier !== 'normal' || Boolean(adversarial && tier === 'extreme')
}
