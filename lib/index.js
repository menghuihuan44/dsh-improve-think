/**
 * dsh-improve-think · 宿主半边
 *
 * 定位（见 README/DESIGN）：
 * - 输入框档位条（思考档 / 对抗开关 / 空转守护 / 首轮快跳）；
 * - 全轮次"空转守护"：只拦"反复无进展"，不拦"想得深"；
 * - 路线校准软规范注入（persona 之后、工具引导之前）。
 *
 * 关键约束：
 * 1. 不全局修改 reasoning_effort，不因为切档降低推理强度；
 * 2. 不确定时默认放行，宁可漏拦；
 * 3. 所有打断/降档/目标对照都写日志；
 * 4. 缺少流式拦截点时明确降级报告，而不是静默失效。
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { DEFAULTS, TIER_LABELS, normalizeConfig, pickPublicConfig } from './core/config.js'
import {
  ACTION,
  VERDICT,
  correctionPrompt,
  createSessionState,
  createStepObservation,
  endTurn,
  evaluateStep,
  shouldAbortMidStream,
  snapshot,
} from './core/stagnation.js'
import { SECTION_NAME, buildSectionText, goalCheckText } from './core/prompts.js'
import { ImproveLogger } from './logger.js'
import { SessionStateStore, resolveBaseDir } from './state-store.js'

export const name = 'dsh-improve-think'
export const inject = ['llm', 'systemPrompt', 'agents']

/**
 * 插件配置（DSH「插件」页 → 本插件 → 配置）。
 *
 * 这里的值是**新会话的默认值**：保存后写进 profile 的 cordis.patch.yml，重启仍在。
 * 单个会话的实时档位由输入框档位条 / `/improve` 覆盖，覆盖记录在
 * `~/.dsh/dsh-improve-think/state.json`，不会写回这里。
 *
 * 声明成 schemastery schema 后，DSH 会自动把它投影成设置表单，
 * Client 半也通过 `ctx.configForms.get('include:dsh-improve-think')` 读写同一份值。
 *
 * 用动态 import 的原因：`@deepseek-ai/schemastery` 是宿主提供的 peer 依赖。
 * 在 DSH profile 里能解析；在纯 Node 环境（例如仓库里的自测）解析不到时，
 * 只是没有设置表单，插件其余功能照常工作 —— 不能因为缺 schema 就整个加载失败。
 */
async function loadConfigSchema() {
  try {
    const z = (await import('@deepseek-ai/schemastery')).default
    // 每个字段都标 .volatile()：DSH 的插件设置页只把「volatile 字段」投影成可编辑表单
    // （dsh-settings 的 describe() 用 volatileForm(schema) 过滤，普通字段的条目会被整体跳过，
    // 插件页就只剩下标题、没有任何设置项）。逐字段标 volatile 也让保存的值能热更新，
    // 不必重启插件 —— 读取时用 configField.get() 取当前值，见下面的 unwrapConfigValue()。
    return z.object({
      tier: z
        .union(['normal', 'strict', 'extreme'])
        .default('normal')
        .volatile()
        .description('默认思考档：常规 / 严格 / 极致（行为规范档，不改推理强度）'),
      adversarial: z
        .boolean()
        .default(false)
        .volatile()
        .description('默认开启对抗审查：动手前查反例与代价，交付前查目标偏离'),
      idleGuard: z.boolean().default(true).volatile().description('默认开启空转守护：只拦"反复无进展"，不拦深度探索'),
      firstTurnFast: z.boolean().default(true).volatile().description('默认开启首轮快跳：首轮先给可执行计划并开始行动'),
      idleGuardAction: z
        .union(['observe', 'interrupt'])
        .default('interrupt')
        .volatile()
        .description('检测到空转时的动作：observe 只记录，interrupt 流内中断并注入纠正提示'),
      stagnationCount: z
        .number()
        .step(1)
        .min(2)
        .max(20)
        .default(3)
        .volatile()
        .description('连续多少轮"无实质进展"才判定空转'),
      reasoningSimilarityThreshold: z
        .number()
        .min(0.5)
        .max(0.98)
        .default(0.8)
        .volatile()
        .description('推理尾部相似度阈值（0.5–0.98，支持两位小数，越高越宽松）'),
      goalCheckInterval: z
        .number()
        .step(1)
        .min(1)
        .max(50)
        .default(5)
        .volatile()
        .description('每隔多少轮做一次目标对照（路线校准）'),
      minReasoningChars: z
        .number()
        .step(1)
        .min(20)
        .max(2000)
        .default(80)
        .volatile()
        .description('推理文本少于这么多字符时不参与空转判定'),
      maxInterruptsPerStep: z
        .number()
        .step(1)
        .min(0)
        .max(3)
        .default(1)
        .volatile()
        .description('同一步骤内最多流内中断次数'),
      log: z.boolean().default(true).volatile().description('写 JSONL 复盘日志到 ~/.dsh/dsh-improve-think/logs'),
      logDir: z.string().default('').volatile().description('自定义日志目录（留空 = 用户数据目录下 logs）'),
      statePath: z.string().default('').volatile().description('自定义状态文件（留空 = 用户数据目录下 state.json）'),
    })
  } catch {
    return undefined
  }
}

/** 设置表单 schema；宿主不提供 schemastery 时为 undefined（插件仍可用）。 */
export const Config = await loadConfigSchema()

/**
 * 读一个配置值。
 *
 * 标了 `.volatile()` 的字段在 DSH 里是「取值器」（`config.tier.get()`），热更新后
 * `.get()` 直接返回新值；在没有 volatile 语义的环境里它就是普通值。两种形态都读。
 */
function readConfigValue(value) {
  if (value === null || typeof value !== 'object') return value
  const read = value.get
  if (typeof read !== 'function') return value
  try {
    return read.call(value)
  } catch {
    return undefined
  }
}

/**
 * 把 apply 收到的条目配置读成普通对象。
 *
 * 不在加载时冻结一份：插件页保存设置后，这里再读就能拿到新值，
 * 于是「新会话默认值」立刻生效，不需要重启插件。
 */
function readPluginConfig(config) {
  const root = readConfigValue(config)
  const out = {}
  for (const [key, value] of Object.entries(root ?? {})) out[key] = readConfigValue(value)
  return out
}

/** systemPrompt.section 的 order：persona(0) 之后、计划策略(500)/工具引导(1000+) 之前。 */
const SECTION_ORDER = 46

/** 流内检测的采样步长：每新增这么多字符才做一次相似度计算，避免拖慢流。 */
const SAMPLE_STRIDE = 120

const COMMAND_NAME = 'improve'

/** 面向模型的工具名：与 /improve 命令共享同一实现。 */
const TOOL_NAME = 'dsh_improve'

export function apply(ctx, config = {}) {
  const readEntryConfig = () => readPluginConfig(config)
  const entryConfig = normalizeConfig(readEntryConfig())
  const store = new SessionStateStore(entryConfig, { defaultsProvider: readEntryConfig })
  const logger = new ImproveLogger({
    dir: entryConfig.logDir || path.join(resolveBaseDir(entryConfig), 'logs'),
    enabled: entryConfig.log !== false,
    sink: (level, message) => {
      try {
        ctx.logger?.[level]?.(message)
      } catch {
        /* 日志器不可用就算了 */
      }
    },
  })

  /** sessionId → 运行时 */
  const runtimes = new Map()
  /** 能力探测结果，用于降级说明。 */
  const capabilities = {
    streamIntercept: false,
    streamReason: 'not-inspected',
    /** 是否真的在真实请求里观察到过 llm/stream（比"注册成功"更强的证据）。 */
    streamObserved: false,
    projection: false,
    commands: false,
    tools: false,
  }

  /** apply 期间会用 ctx.inject 注册的依赖；全部收尾后才写最终能力报告。 */
  const PENDING_INJECTIONS = ['sessionProjections', 'commands', 'tools']

  function runtimeFor(sessionId) {
    if (!sessionId) return null
    let rt = runtimes.get(sessionId)
    if (rt) return rt
    rt = {
      sessionId,
      state: createSessionState(store.configFor(sessionId)),
      observation: createStepObservation(),
      agent: null,
      /** 本步是否已出现工具调用（流内保护用）。 */
      stepHasToolCall: false,
      /** 是否见过本步的 step/start；没见过就收到 step/end 说明是插件加载前开跑的步，不能评估。 */
      stepOpen: false,
      /** 只为诊断：本步是否观察到 reasoning-delta。 */
      stepSawReasoning: false,
      inspectedAt: Date.now(),
    }
    runtimes.set(sessionId, rt)
    if (runtimes.size > 200) {
      // 简单的容量保护：丢最早创建的会话运行时（下次访问会从磁盘配置重建）。
      const oldest = [...runtimes.values()].sort((a, b) => a.inspectedAt - b.inspectedAt)[0]
      if (oldest && oldest.sessionId !== sessionId) runtimes.delete(oldest.sessionId)
    }
    return rt
  }

  function refreshConfig(rt) {
    rt.state.config = store.configFor(rt.sessionId)
    return rt.state.config
  }

  function log(rt, event, data = {}) {
    logger.log(rt?.sessionId, event, { turn: rt?.state?.turn, step: rt?.state?.step, ...data })
  }

  /**
   * 构造一条"插件干预"用户消息。
   *
   * Agent loop 的 followup/steer/inject 要求完整 message 对象（不包装字符串），
   * 必需字段：非空 id、role:'user'、content 数组、source.kind。
   * 这里不依赖 @deepseek-ai/dsh-llm 的 createUserMessage，避免插件多一个宿主包依赖；
   * source.kind 用 'dsh-improve-think' 便于在会话记录里区分"插件注入"和"用户输入"。
   */
  function noticeMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-improve-think', form: 'notice', summary: 'dsh-improve-think 干预' },
    }
  }

  // ---------------------------------------------------------------- 系统提示词

  // 路线校准 + 档位行为规范。放在 persona 之后、工具引导之前（order 46）。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: (context) => {
          try {
            const session = context?.agent?.session
            const rt = runtimeFor(session?.id)
            if (!rt) return ''
            const runtimeConfig = rt.state.config
            return buildSectionText({
              config: runtimeConfig,
              isFirstTurn: rt.state.turn <= 1,
            })
          } catch {
            return ''
          }
        },
      }),
    'dsh-improve-think: 路线校准与档位规范',
  )

  // ---------------------------------------------------------------- 空转守护 · 流内

  // 流式推理拦截：观察 reasoning-delta；只在"明确重复且无工具调用"时提前收尾。
  // 若当前版本没有该扩展点，注册会失败，此时仅降级为"轮次后检测"。
  const disposeStream = ctx.on('llm/stream', (options, next) => guardStream(options, next))
  capabilities.streamIntercept = true
  capabilities.streamReason = 'llm/stream'
  ctx.effect(() => disposeStream, 'dsh-improve-think: 流式推理拦截')

  async function* guardStream(options, next) {
    const rt = runtimeFor(options?.sessionId)
    const upstream = await next()
    if (!rt) {
      yield* upstream
      return
    }
    rt.streamSeen = true
    capabilities.streamIntercept = true
    capabilities.streamReason = 'llm/stream'
    rt.noStreamStreak = 0
    if (!capabilities.streamObserved) {
      // 只在插件加载后第一次拿到真实流时记一条：这是"流内拦截确实可用"的硬证据，
      // 比注册成功（只说明事件名存在）更能证明真实环境没有降级。
      capabilities.streamObserved = true
      log(rt, 'stream.observed', {
        provider: options?.provider ?? '',
        model: options?.model ?? '',
        reasoningEffort: options?.reasoningEffort ?? '',
      })
    }
    const runtimeConfig = refreshConfig(rt)
    if (!runtimeConfig.idleGuard) {
      yield* upstream
      return
    }

    let reasoning = ''
    let lastSampleAt = 0
    let openBlock = null
    let aborted = false

    try {
      for await (const chunk of upstream) {
        if (chunk?.type === 'block-start') {
          openBlock = { index: chunk.index, blockType: chunk.blockType, text: '' }
        } else if (chunk?.type === 'tool-call-delta') {
          rt.stepHasToolCall = true
        } else if (chunk?.type === 'text-delta') {
          // 可见文本要记进本步观测：判断"只输出好/做/执行"靠它。
          rt.observation.text += chunk.text ?? ''
          if (openBlock && openBlock.blockType === 'text') openBlock.text += chunk.text ?? ''
        } else if (chunk?.type === 'reasoning-delta') {
          rt.stepSawReasoning = true
          reasoning += chunk.text ?? ''
          if (openBlock && openBlock.blockType === 'reasoning') openBlock.text += chunk.text ?? ''
          if (!aborted) {
            // 第一次采样在达到最小推理长度时就做，之后每 SAMPLE_STRIDE 个新字符采样一次。
            const firstSampleDue =
              lastSampleAt === 0 && reasoning.length >= Math.min(runtimeConfig.minReasoningChars, SAMPLE_STRIDE)
            const periodicSampleDue = lastSampleAt > 0 && reasoning.length - lastSampleAt >= SAMPLE_STRIDE
            if (firstSampleDue || periodicSampleDue) {
              lastSampleAt = reasoning.length
              const decision = shouldAbortMidStream(rt.state, reasoning, { hasToolCall: rt.stepHasToolCall })
              if (decision.abort) {
                aborted = true
                rt.state.marked = true
                rt.state.markedAt = new Date().toISOString()
                rt.state.markReason = `stream-repetitive (similarity=${decision.similarity})`
                rt.state.pendingCorrection = correctionPrompt()
                rt.state.stats.interrupted += 1
                log(rt, 'idle.interrupt.stream', {
                  similarity: decision.similarity,
                  reasoningChars: reasoning.length,
                  action: runtimeConfig.idleGuardAction,
                })
                // 收尾：尽量把当前块闭合，再给一个 stop，避免留下半个块。
                if (openBlock && (openBlock.blockType === 'text' || openBlock.blockType === 'reasoning')) {
                  yield {
                    type: 'block-end',
                    index: openBlock.index,
                    block: { type: openBlock.blockType, text: openBlock.text },
                  }
                  openBlock = null
                }
                yield { type: 'finish', reason: { kind: 'stop' } }
                return
              }
            }
          }
        } else if (chunk?.type === 'block-end') {
          openBlock = null
        } else if (chunk?.type === 'finish') {
          openBlock = null
        }
        yield chunk
      }
    } finally {
      // 把本步推理交给观测账本：step/end 的评估要用它做"尾部重复"比较。
      if (reasoning) rt.observation.reasoning = reasoning
      rt.lastStreamEndedAt = Date.now()
    }
  }

  // ---------------------------------------------------------------- 轮次与步的账本

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    const rt = runtimeFor(sessionId)
    if (!rt) return
    const data = event?.data ?? {}
    try {
      switch (event?.type) {
        case 'turn/start': {
          // 轮次序号以宿主事件为准，避免自己数错。
          rt.state.turn = Math.max(rt.state.turn + 1, Number(data.turn) || 0)
          rt.state.step = 0
          rt.state.interruptsThisStep = 0
          rt.state.toolCallsThisTurn = 0
          rt.observation = createStepObservation()
          rt.stepHasToolCall = false
          rt.stepSawReasoning = false
          rt.stepOpen = false
          log(rt, 'turn.start', { turn: rt.state.turn, tier: rt.state.config.tier })
          break
        }
        case 'step/start': {
          rt.state.step = Math.max(rt.state.step + 1, Number(data.step) || 0)
          rt.state.interruptsThisStep = 0
          rt.observation = createStepObservation()
          rt.stepHasToolCall = false
          rt.stepSawReasoning = false
          rt.stepOpen = true
          break
        }
        case 'tool/call': {
          rt.observation.toolCalls += 1
          rt.stepHasToolCall = true
          break
        }
        case 'assistant/message': {
          // 降级路径：没有流式拦截点时，只能在这里（轮次内）读到已组装的回复。
          if (!rt.streamSeen && data?.message?.content) {
            for (const block of data.message.content) {
              if (block?.type === 'text') rt.observation.text += block.text ?? ''
              else if (block?.type === 'reasoning') rt.observation.reasoning += block.text ?? ''
              else if (block?.type === 'tool-call') rt.observation.toolCalls += 1
            }
          }
          break
        }
        case 'step/end': {
          if (!rt.stepOpen) {
            // 插件加载前就开跑的步（或会话重放）只有 end 没有 start：
            // 这条观测是空的，评估它只会产出误导性的 "no-visible-output"，
            // 直接跳过，等下一个完整步再算。
            break
          }
          rt.stepOpen = false
          finishStep(rt)
          break
        }
        case 'turn/end': {
          rt.stepOpen = false
          const pending = endTurn(rt.state)
          if (pending) log(rt, 'route.goal-check.scheduled', { turn: pending.turn })
          maybeResume(rt)
          break
        }
        default:
          break
      }
    } catch (error) {
      log(rt, 'internal.error', { where: `session/event:${event?.type}`, message: String(error?.message ?? error) })
    }
  })

  function finishStep(rt) {
    const observation = rt.observation
    // 完全没有观察到流（例如该适配器不流式输出推理）→ 记录降级，交给 evaluateStep 放行。
    if (!rt.streamSeen) {
      rt.noStreamStreak = (rt.noStreamStreak ?? 0) + 1
      if (rt.noStreamStreak === 3) {
        capabilities.streamIntercept = false
        capabilities.streamReason = 'no-stream-observed'
        capabilities.degraded = true
        capabilities.note =
          '连续 3 个 step 没有观察到 llm/stream 数据：流内打断不可用，已降级为「工具预执行 + 轮次后检测 + 注入纠正提示」。'
        log(rt, 'degrade.no-stream-hook', {
          message: '连续 3 个 step 没有观察到 llm/stream 数据；流内打断不可用，已降级为「工具预执行 + 轮次后检测 + 注入纠正提示」。',
        })
      }
    } else {
      rt.streamSeen = false
    }
    const result = evaluateStep(rt.state, observation)
    rt.observation = createStepObservation()

    if (result.action === ACTION.OBSERVE) {
      // 只对"确实观察到了输出、但判断不了"的步记日志。
      // 纯空观测（没有任何文本/推理/工具）不是"疑似空转"，它只是没数据，
      // 记下来只会把日志灌满，也违背"不确定就放行、宁可漏拦"的取向。
      const observedSomething =
        result.signals.textChars > 0 || result.signals.reasoningChars > 0 || result.signals.toolCalls > 0
      if (result.verdict !== VERDICT.UNKNOWN || observedSomething) {
        log(rt, 'idle.observe', {
          verdict: result.verdict,
          reason: result.reason,
          streak: result.streak,
          similarity: result.signals.similarity,
          textChars: result.signals.textChars,
          reasoningChars: result.signals.reasoningChars,
        })
      }
    } else if (result.action === ACTION.INTERRUPT) {
      log(rt, 'idle.interrupt', {
        verdict: result.verdict,
        reason: result.reason,
        streak: result.streak,
        similarity: result.signals.similarity,
      })
    }
    return result
  }

  /**
   * 轮次结束后，如果还有待注入的纠正提示/目标对照，就把 agent 唤醒到下一轮。
   *
   * 为什么必须唤醒：流内打断会让本次 assistant 消息没有工具调用，宿主会判定本轮结束；
   * 如果不 followup，任务就停在这里了——而需求要求"打断后让任务继续，不终止会话"。
   */
  function maybeResume(rt) {
    const correction = rt.state.pendingCorrection
    const goalCheck = rt.state.pendingGoalCheck
    if (!correction && !goalCheck) return
    const parts = []
    if (correction) parts.push(correction)
    if (goalCheck) {
      parts.push(goalCheckText(goalCheck.turn, rt.state.config.goalCheckInterval))
      rt.state.pendingGoalCheck = null
    }
    rt.state.pendingCorrection = null
    const text = parts.join('\n\n')
    const agent = resolveAgent(rt)
    if (!agent || typeof agent.followup !== 'function') {
      log(rt, 'resume.skipped', { reason: 'agent-unavailable' })
      return
    }
    try {
      // followup 的入参必须是一条完整 message 对象（Agent loop 不做字符串包装）。
      agent.followup(noticeMessage(text))
      log(rt, 'resume.followup', {
        correction: Boolean(correction),
        goalCheck: Boolean(goalCheck),
        chars: text.length,
      })
    } catch (error) {
      log(rt, 'resume.failed', { message: String(error?.message ?? error) })
      // 失败就保留到下一次，不丢信息。
      if (correction) rt.state.pendingCorrection = correction
      if (goalCheck) rt.state.pendingGoalCheck = goalCheck
    }
  }

  function resolveAgent(rt) {
    if (rt.agent) return rt.agent
    try {
      const found = ctx.agents?.get?.(rt.sessionId)
      if (found) rt.agent = found
      return found ?? null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- 工具门禁（记账）

  const disposePreExecute = ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    try {
      const rt = runtimeFor(exec?.agent?.session?.id ?? exec?.sessionId)
      if (rt) {
        rt.stepHasToolCall = true
        if (decision?.kind === 'allow') rt.observation.toolCalls = Math.max(1, rt.observation.toolCalls)
      }
    } catch {
      /* 记账失败不影响工具执行 */
    }
    return decision
  })
  ctx.effect(() => disposePreExecute, 'dsh-improve-think: 工具调用记账')

  // ---------------------------------------------------------------- agent 生命周期

  ctx.on('agent/created', ({ agent }) => {
    try {
      const sessionId = agent?.session?.id
      const rt = runtimeFor(sessionId)
      if (rt) rt.agent = agent
    } catch {
      /* ignore */
    }
    return undefined
  })

  // 兼容：某些路径下 agent/pre-step 比 agent/created 更早到达，这里补登记 agent 引用。
  const disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const rt = runtimeFor(payload?.agent?.session?.id)
      if (rt) rt.agent = payload.agent
    } catch {
      /* ignore */
    }
    return decision
  })
  ctx.effect(() => disposePreStep, 'dsh-improve-think: agent 引用跟踪')

  // ---------------------------------------------------------------- 档位投影（供 UI 读取）

  // Client 半只能通过 wire projection 读到 Host 派生值（它不能自己折叠 session 事件，
  // 也没有 host.call 这种私有 RPC）。这里把档位/空转状态投影出去，key 与 client.js 对齐。
  const projectionSchema = {
    parse: (value) => value,
    safeParse: (value) => ({ success: true, data: value }),
    '~standard': { version: 1, vendor: 'dsh-improve-think', validate: (value) => ({ value }) },
  }

  function projectionView(sessionId) {
    const cfg = store.configFor(sessionId)
    const state = sessionId ? runtimes.get(sessionId)?.state : undefined
    return {
      sessionId: sessionId ?? null,
      tier: cfg.tier,
      tierLabel: TIER_LABELS[cfg.tier] ?? TIER_LABELS.normal,
      adversarial: cfg.adversarial === true,
      idleGuard: cfg.idleGuard !== false,
      firstTurnFast: cfg.firstTurnFast !== false,
      idleGuardAction: cfg.idleGuardAction,
      stagnationCount: cfg.stagnationCount,
      goalCheckInterval: cfg.goalCheckInterval,
      turn: state?.turn ?? 0,
      streak: state?.streak ?? 0,
      marked: state?.marked === true,
      markedAt: state?.markedAt ?? null,
      markReason: state?.markReason ?? null,
      stats: {
        observed: state?.stats?.observed ?? 0,
        interrupted: state?.stats?.interrupted ?? 0,
        goalChecks: state?.stats?.goalChecks ?? 0,
      },
      capabilities: {
        streamIntercept: capabilities.streamIntercept,
        degraded: capabilities.degraded === true,
        note: capabilities.note ?? '',
      },
    }
  }

  ctx.inject(['sessionProjections'], (scoped) => {
    capabilities.projection = true
    try {
      scoped.sessionProjections.register({
        key: 'dshImproveThink',
        stateVersion: 1,
        // 双写：新版宿主读 stateSchema，旧版读 schema。
        stateSchema: projectionSchema,
        schema: projectionSchema,
        init: (header) => {
          const sessionId = String(header?.id ?? '')
          return { sessionId, ...projectionView(sessionId) }
        },
        apply: (state) => {
          const sessionId = String(state?.sessionId ?? '')
          return { sessionId, ...projectionView(sessionId) }
        },
        wire: {
          viewSchema: projectionSchema,
          // 每次 session 事件都返回新对象引用，确保 registry 判定状态变化并推送一次。
          view: (state) => ({ ...state }),
        },
      })
    } catch (error) {
      capabilities.projection = false
      capabilities.note = capabilities.note || `投影注册失败：${error?.message ?? error}`
    } finally {
      settleInjection('sessionProjections')
    }
  })

  // ---------------------------------------------------------------- 命令（UI 写回）

  ctx.inject(['commands'], (scoped) => {
    const commands = scoped.commands
    if (!commands?.register) {
      settleInjection('commands')
      return
    }
    capabilities.commands = true
    settleInjection('commands')
    scoped.effect(
      () =>
        commands.register({
          name: COMMAND_NAME,
          description: '调整 dsh-improve-think 的思考档与守护开关（tier / adversarial / idleGuard / firstTurnFast / status / reset）',
          input: { hint: 'tier strict | adversarial on | idleGuard off | firstTurnFast off | status | reset' },
          recordInput: false,
          handler: (invocation) => handleCommand(invocation),
        }),
      'dsh-improve-think: improve 命令',
    )
  })

  /**
   * 设置操作的唯一实现：命令、工具、UI 点击三条路径都走这里。
   * 返回 { ok, text }，由调用方转成各自的返回形状。
   */
  function runSettings(sessionId, rawInput) {
    const rt = runtimeFor(sessionId)
    if (!rt) return { ok: false, text: 'dsh-improve-think：找不到当前会话状态。' }
    const raw = String(rawInput ?? '').trim()
    const [verbRaw, valueRaw] = raw.split(/\s+/, 2)
    const verb = (verbRaw ?? '').toLowerCase()
    const value = (valueRaw ?? '').toLowerCase()

    if (!verb || verb === 'status') {
      return { ok: true, text: describeStatus(rt) }
    }
    if (verb === 'reset') {
      store.resetSession(sessionId)
      refreshConfig(rt)
      log(rt, 'config.reset', {})
      return { ok: true, text: `已重置为默认档位。\n${describeStatus(rt)}` }
    }
    if (verb === 'tier') {
      if (!['normal', 'strict', 'extreme'].includes(value)) {
        return { ok: false, text: 'tier 只能是 normal / strict / extreme。' }
      }
      applyPatch(rt, { tier: value })
      return { ok: true, text: `思考档 → ${TIER_LABELS[value]}（${value}）` }
    }
    if (verb === 'adversarial' || verb === 'idleguard' || verb === 'firstturnfast') {
      const key = verb === 'adversarial' ? 'adversarial' : verb === 'idleguard' ? 'idleGuard' : 'firstTurnFast'
      if (['on', 'true', '1', '开'].includes(value)) {
        applyPatch(rt, { [key]: true })
        return { ok: true, text: `${key} → 开` }
      }
      if (['off', 'false', '0', '关'].includes(value)) {
        applyPatch(rt, { [key]: false })
        return { ok: true, text: `${key} → 关` }
      }
      // 只给开关名不给值时，等价于切换。
      if (!value) {
        const next = { ...rt.state.config, [key]: !rt.state.config[key] }
        applyPatch(rt, { [key]: next[key] })
        return { ok: true, text: `${key} → ${next[key] ? '开' : '关'}` }
      }
      return { ok: false, text: `${key} 只接受 on / off。` }
    }
    if (verb === 'observe') {
      applyPatch(rt, { idleGuardAction: 'observe' })
      return { ok: true, text: '空转守护动作 → observe（只记录，不打断）' }
    }
    if (verb === 'interrupt') {
      applyPatch(rt, { idleGuardAction: 'interrupt' })
      return { ok: true, text: '空转守护动作 → interrupt（标记后流内打断）' }
    }
    return { ok: false, text: `未知子命令：${verb}` }
  }

  function handleCommand(invocation) {
    const sessionId = invocation?.agent?.session?.id ?? invocation?.agent?.id
    const result = runSettings(sessionId, invocation?.rawInput)
    return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
  }

  // ---------------------------------------------------------------- 工具（同一操作的第二个调用者）

  // 按 user-actions.md 的"一个操作两个调用者"：UI 点击与 /improve 命令之外，
  // 再把这个 Host 操作暴露成 agent 工具——这样人和模型都能读状态、调档位，且逻辑只有一份。
  ctx.inject(['tools'], (scoped) => {
    const tools = scoped.tools ?? scoped.get?.('tools')
    if (!tools?.register) {
      settleInjection('tools')
      return
    }
    capabilities.tools = true
    settleInjection('tools')
    scoped.effect(
      () =>
        tools.register({
          name: TOOL_NAME,
          description:
            '读取或调整 dsh-improve-think 的思考档（normal 常规 / strict 严格 / extreme 极致）与空转守护开关；与输入框档位条、/improve 命令是同一套操作。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['status', 'tier', 'adversarial', 'idleGuard', 'firstTurnFast', 'observe', 'interrupt', 'reset'],
                description: 'status 只读；其余为修改。',
              },
              value: {
                type: 'string',
                description: 'action=tier 时取 normal/strict/extreme；开关类取 on/off；省略则切换。',
              },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
              required: ['ok', 'text'],
            },
            render: (args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          execute: async (args, exec) => {
            const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
            const raw = [args?.action, args?.value].filter(Boolean).join(' ')
            const result = runSettings(sessionId, raw)
            if (!result.ok) throw new Error(result.text)
            return { ok: true, text: result.text }
          },
        }),
      'dsh-improve-think: improve 工具',
    )
  })

  function applyPatch(rt, patch) {
    store.patchSession(rt.sessionId, patch)
    refreshConfig(rt)
    log(rt, 'config.patch', { patch })
  }

  /**
   * 查询 Host 的 settings 服务有没有把本插件投影成可编辑表单。
   *
   * 这是「插件页里能不能改设置」的唯一判据：`settings.describe()` 只列出**含 volatile 字段**
   * 的条目（dsh-settings 的 volatileForm 过滤）。少标一个 `.volatile()`，插件页里就只剩标题、
   * 没有任何设置项，所以把结果直接写进 `/improve status` 与启动日志，便于排查。
   */
  function inspectSettingsForm() {
    try {
      const settings = ctx.get?.('settings')
      if (!settings || typeof settings.describe !== 'function') return { status: 'unsupported' }
      const rows = settings.describe()
      if (!Array.isArray(rows)) return { status: 'unsupported' }
      const row = rows.find((item) => typeof item?.ns === 'string' && item.ns.includes('dsh-improve-think'))
      if (!row) return { status: 'missing' }
      return { status: 'served', ns: row.ns, fields: Object.keys(row.value ?? {}) }
    } catch (error) {
      return { status: 'error', message: String(error?.message ?? error) }
    }
  }

  function describeStatus(rt) {
    const c = rt.state.config
    const snap = snapshot(rt.state)
    const settingsForm = inspectSettingsForm()
    const settingsLine =
      settingsForm.status === 'served'
        ? `设置页：已开放（${settingsForm.ns}，${settingsForm.fields.length} 个字段）`
        : settingsForm.status === 'missing'
          ? '设置页：未开放（settings.describe 未列出本插件：配置字段必须带 .volatile()）'
          : `设置页：无法查询（${settingsForm.status === 'error' ? settingsForm.message : 'settings 服务不可用'}）`
    return [
      `思考档：${TIER_LABELS[c.tier]}（${c.tier}）  对抗：${c.adversarial ? '开' : '关'}  空转守护：${c.idleGuard ? '开' : '关'}（${c.idleGuardAction}）  首轮快跳：${c.firstTurnFast ? '开' : '关'}`,
      `阈值：stagnationCount=${c.stagnationCount}  similarity=${c.reasoningSimilarityThreshold}  goalCheckInterval=${c.goalCheckInterval}`,
      `状态：turn=${snap.turn} step=${snap.step} streak=${snap.streak}${snap.marked ? '（疑似空转已标记）' : ''}`,
      `流式拦截：${capabilities.streamIntercept ? '可用' : '不可用（已降级为轮次后检测）'}`,
      `诊断：stream=${capabilities.streamObserved ? '已观察到 llm/stream' : '尚未观察到流'}  投影=${capabilities.projection ? '已注册' : '未注册'}  命令=${capabilities.commands ? '已注册' : '未注册'}  工具=${capabilities.tools ? '已注册' : '未注册'}`,
      settingsLine,
    ].join('\n')
  }

  // ---------------------------------------------------------------- 收尾

  ctx.effect(
    () => () => {
      try {
        store.dispose()
      } catch {
        /* ignore */
      }
      runtimes.clear()
    },
    'dsh-improve-think: 落盘与清理',
  )

  ctx.on('session/flush', () => {
    store.flushNow()
  })

  // 首次加载时把能力报告写进日志，方便用户复盘"是否降级"。
  //
  // 注意：ctx.inject([...]) 的回调是"依赖就绪后"才异步执行的，apply 返回这一刻还拿不到
  // projection/commands/tools 的注册结果。所以这里先记一条"已加载"，等三个注入点都收尾
  // （或 3 秒兜底超时）再补一条最终能力报告——否则日志里会永远写着 false，误导复盘。
  logger.log(null, 'plugin.loaded', {
    tier: entryConfig.tier,
    idleGuard: entryConfig.idleGuard,
    idleGuardAction: entryConfig.idleGuardAction,
    capabilities: { ...capabilities },
    pendingInjections: PENDING_INJECTIONS.slice(),
    stateFile: store.file,
    logDir: logger.dir,
  })

  let capabilitiesReported = false
  const reportTimer = setTimeout(() => reportCapabilities('timeout'), 1500)
  reportTimer?.unref?.()

  function reportCapabilities(reason) {
    if (capabilitiesReported) return
    capabilitiesReported = true
    clearTimeout(reportTimer)
    const settingsForm = inspectSettingsForm()
    logger.log(null, 'capabilities.ready', { reason, ...capabilities, settingsForm })
    // describe() 要求条目 fiber 已回到 active 态，而注入收尾（~25ms）时通常还没到，
    // 于是这里会误报 missing。延迟再查一次并单独记一条，免得复盘时被首次快照带偏。
    if (settingsForm.status !== 'served') {
      const recheck = setTimeout(() => {
        logger.log(null, 'settings.form.checked', { reason, ...inspectSettingsForm() })
      }, 2500)
      recheck?.unref?.()
      ctx.effect?.(() => () => clearTimeout(recheck), 'dsh-improve-think: 设置页复查计时器')
    }
  }

  function settleInjection(key) {
    const at = PENDING_INJECTIONS.indexOf(key)
    if (at >= 0) PENDING_INJECTIONS.splice(at, 1)
    if (PENDING_INJECTIONS.length === 0) reportCapabilities('injections-settled')
  }


  // 暴露给测试/工具读取的只读句柄（不作为服务契约）。
  ctx.provide?.('dshImproveThinkInternal', {
    getCapabilities: () => ({ ...capabilities }),
    getState: (sessionId) => {
      const rt = runtimes.get(sessionId)
      return rt ? snapshot(rt.state) : null
    },
    getConfig: (sessionId) => pickPublicConfig(store.configFor(sessionId)),
    log,
  })
}

