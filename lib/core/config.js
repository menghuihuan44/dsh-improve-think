/**
 * dsh-improve-think 的配置模型与默认值。
 *
 * 这里的默认值就是"产品默认行为"，任何归一化都只做范围收敛，不改变语义：
 * - idleGuardAction 默认 interrupt：用户显式切到 observe 后才只记录不打断。
 * - 思考档默认 normal，且**永远不影响 reasoning_effort**（见 DESIGN.md §3）。
 */

export const TIERS = Object.freeze(['normal', 'strict', 'extreme'])
export const IDLE_GUARD_ACTIONS = Object.freeze(['observe', 'interrupt'])

export const TIER_LABELS = Object.freeze({
  normal: '常规',
  strict: '严格',
  extreme: '极致',
})

export const DEFAULTS = Object.freeze({
  /** 思考档：normal 常规 / strict 严格 / extreme 极致。行为规范档，不是推理强度开关。 */
  tier: 'normal',
  /** 对抗开关：与 tier=extreme 叠加时开启反例与代价审查。 */
  adversarial: false,
  /** 空转守护总开关。默认开。 */
  idleGuard: true,
  /** 首轮快跳：首轮注入"先形成可执行计划并开始行动"的轻量约束。默认开。 */
  firstTurnFast: true,
  /** 连续停滞多少步（step）才触发守护动作。 */
  stagnationCount: 3,
  /** 推理尾部相似度阈值，达到即视为重复。 */
  reasoningSimilarityThreshold: 0.8,
  /** 每多少轮做一次目标对照。 */
  goalCheckInterval: 5,
  /** observe = 只记录并标记；interrupt = 流内中断并注入纠正提示。 */
  idleGuardAction: 'interrupt',

  /* ---- 以下是内部调参项，UI 不暴露，但配置里可覆盖 ---- */
  /** 判定"推理有实质内容"的最小归一化字符数。 */
  minReasoningChars: 80,
  /** 单个 assistant 步骤内最多打断几次（防止打断风暴）。 */
  maxInterruptsPerStep: 1,
  /** 遥测：是否写日志文件。 */
  log: true,
  /** 日志目录，留空用 ~/.dsh/dsh-improve-think/logs。 */
  logDir: '',
  /** 会话状态文件路径，留空用 ~/.dsh/dsh-improve-think/state.json。 */
  statePath: '',
})

function clampInt(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

function clampFloat(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * 归一化任意来源（插件 config / 会话状态 / UI 写入）的配置。
 * 绝不抛错：脏值一律回落到默认，保证守护本身不会成为故障源。
 */
export function normalizeConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    tier: pickEnum(input.tier, TIERS, DEFAULTS.tier),
    adversarial: Boolean(input.adversarial ?? DEFAULTS.adversarial),
    idleGuard: Boolean(input.idleGuard ?? DEFAULTS.idleGuard),
    firstTurnFast: Boolean(input.firstTurnFast ?? DEFAULTS.firstTurnFast),
    stagnationCount: clampInt(input.stagnationCount, DEFAULTS.stagnationCount, 2, 20),
    reasoningSimilarityThreshold: clampFloat(
      input.reasoningSimilarityThreshold,
      DEFAULTS.reasoningSimilarityThreshold,
      0.5,
      0.98,
    ),
    goalCheckInterval: clampInt(input.goalCheckInterval, DEFAULTS.goalCheckInterval, 1, 50),
    idleGuardAction: pickEnum(input.idleGuardAction, IDLE_GUARD_ACTIONS, DEFAULTS.idleGuardAction),
    minReasoningChars: clampInt(input.minReasoningChars, DEFAULTS.minReasoningChars, 20, 4000),
    maxInterruptsPerStep: clampInt(input.maxInterruptsPerStep, DEFAULTS.maxInterruptsPerStep, 1, 3),
    log: Boolean(input.log ?? DEFAULTS.log),
    logDir: typeof input.logDir === 'string' ? input.logDir : DEFAULTS.logDir,
    statePath: typeof input.statePath === 'string' ? input.statePath : DEFAULTS.statePath,
  }
}

/** 供 UI 读取的"可公开旋钮"白名单。 */
export const PUBLIC_KEYS = Object.freeze([
  'tier',
  'adversarial',
  'idleGuard',
  'firstTurnFast',
  'stagnationCount',
  'reasoningSimilarityThreshold',
  'goalCheckInterval',
  'idleGuardAction',
  'minReasoningChars',
  'maxInterruptsPerStep',
])

/** 从 patch 片段里挑出允许 UI 修改的字段。 */
export function pickPublicConfig(raw = {}) {
  const normalized = normalizeConfig(raw)
  const out = {}
  for (const key of PUBLIC_KEYS) out[key] = normalized[key]
  return out
}

/**
 * 只挑出「调用方显式给出」的字段（缺失字段不会被默认值填满）。
 *
 * 会话覆盖必须用它：如果每改一个开关就把整份默认配置写进会话，用户之后在插件页
 * 调整其它设置就再也不会影响这个会话了——那正是"改了设置却不生效"的来源。
 */
export function pickPublicOverrides(raw = {}) {
  if (!raw || typeof raw !== 'object') return {}
  const normalized = normalizeConfig(raw)
  const out = {}
  for (const key of PUBLIC_KEYS) {
    if (Object.hasOwn(raw, key)) out[key] = normalized[key]
  }
  return out
}
