/**
 * 文本信号工具：归一化、推理尾部相似度、空话短句检测、结论复发签名、计划增量计数。
 *
 * 全部是纯函数，不 import 任何 DSH 包，方便用 node --test 直接单元测试。
 * 设计原则（见 DESIGN.md §4）：宁可漏判，不可误判；所有判定都返回可解释的中间量。
 */

const PUNCT_RE =
  /[\s\u3000\u200b-\u200d\ufeff!-/:-@[-`{-~\u3001-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+/g

/** 去掉空白与标点、转小写，用于相似度与签名比较。 */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(PUNCT_RE, '')
}

/** 归一化后的字符数，用于"推理有没有实质内容"的粗判。 */
export function normalizedLength(value) {
  return normalizeText(value).length
}

/** 取文本尾部若干字符：模型复述时通常是尾部结论重复。 */
export function tailOf(value, maxChars = 320) {
  const text = normalizeText(value)
  const size = Number.isFinite(maxChars) ? Math.max(60, Math.trunc(maxChars)) : 320
  return text.length <= size ? text : text.slice(-size)
}

function ngramSet(text, n) {
  const set = new Set()
  if (!text) return set
  if (text.length < n) {
    set.add(text)
    return set
  }
  for (let i = 0; i + n <= text.length; i += 1) set.add(text.slice(i, i + n))
  return set
}

/** 集合 Jaccard 相似度，0..1。 */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const item of small) if (big.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * 两段推理文本的"尾部相似度"，0..1。
 *
 * 用 2-gram 与 3-gram 的 Jaccard 取较大值：中文没有词边界，字符 n-gram 比 token 切分更稳；
 * 取 max 而不是平均，是因为"整段重复"和"结论段重复"都应该被识别为停滞。
 * 任一侧有效内容不足 minChars 时返回 0（信息不足 → 不做判断，交给上层放行）。
 */
export function tailSimilarity(previous, next, minChars = 60) {
  const a = tailOf(previous)
  const b = tailOf(next)
  if (a.length < minChars || b.length < minChars) return 0
  const bigram = jaccard(ngramSet(a, 2), ngramSet(b, 2))
  const trigram = jaccard(ngramSet(a, 3), ngramSet(b, 3))
  return Math.round(Math.max(bigram, trigram) * 1000) / 1000
}

/** 只包含"好/做/执行/收到"这类无实质进展短句的词典。 */
const FILLER_WORDS = new Set([
  '好', '好的', '好嘞', '好滴', '好呀', '行', '可以', '没问题',
  '嗯', '嗯嗯', '对', '是的', '没错', '收到', '明白', '明白了', '了解', '知道了',
  '做', '执行', '继续', '开始', '马上', '立刻', '这就做', '我来做', '我这就做',
  '好的我来做', '好我这就做', '好的我这就做', '好的马上执行', '收到马上执行',
  'ok', 'okay', 'sure', 'go', 'yes', 'yep', 'doing', 'working', 'next',
  '下一步', '继续执行', '开始执行', '这就开始', '我开始了',
])

/**
 * 整条回复是否只是"好/做/执行"这类空转短句。
 *
 * 保守边界：超过 12 个字符一律不算空话——真正的空转几乎都是极短回复，
 * 长文本即使啰嗦也可能包含新信息，不能在这里拦。
 */
export function isFillerOnly(value) {
  const compact = normalizeText(value)
  if (!compact) return false
  if (compact.length > 12) return false
  if (FILLER_WORDS.has(compact)) return true
  const parts = String(value ?? '')
    .split(/[，,。.！!？?；;、:\s]+/)
    .map(normalizeText)
    .filter(Boolean)
  return parts.length > 0 && parts.every((part) => FILLER_WORDS.has(part))
}

/**
 * 结论签名：取归一化文本尾部固定长度。
 *
 * 用途：同一结论被反复重述时，尾部文本高度一致；用尾部切片而不是哈希，
 * 便于日志里直接看出重复了什么。
 */
export function conclusionSignature(value, size = 96) {
  const text = normalizeText(value)
  if (text.length < 12) return ''
  return text.slice(-Math.max(12, Math.trunc(size)))
}

const NUMBERED_LINE_RE = /^\s*(?:\d{1,2}[.)、]|[-*+]\s)/
const NAMED_STEP_RE = /^\s*(?:第[一二三四五六七八九十]+步|下一步|step\s*\d+|todo\s*\d+)/i

/** 统计文本里的"计划条目"数量，用于判断计划是否有增量。 */
export function planItemCount(value) {
  const lines = String(value ?? '').split(/\r?\n/)
  let count = 0
  for (const line of lines) {
    if (NUMBERED_LINE_RE.test(line) || NAMED_STEP_RE.test(line)) count += 1
  }
  return count
}

/** 截断用于日志/UI 展示的简短摘要（保留中文，不破坏 UTF-16 代理对以外的内容）。 */
export function summarize(value, maxChars = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}
