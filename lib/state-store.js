/**
 * 会话级配置持久化。
 *
 * 为什么自己写文件而不是用 configEditor：
 * - configEditor 管的是"插件条目配置"（profile 级），改它会重启插件；
 * - 这里要的是"每个会话各有一套档位，重启 DSH 后仍在"，属于插件私有数据；
 * - 因此落在 ~/.dsh/dsh-improve-think/state.json，原子写 + 去抖，坏了就自动重建，绝不让插件起不来。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, normalizeConfig, pickPublicConfig, pickPublicOverrides } from './core/config.js'

// v2 起：会话条目只存「用户显式改过的字段」（overrides），其余字段实时跟随插件页默认值。
// v1 存的是整份生效配置，导致插件页改了设置对已有会话毫无影响（用户报障的问题）。
const STATE_VERSION = 2

export function resolveHomeDir(explicit) {
  if (explicit) return explicit
  const fromEnv = process.env.DSH_HOME || process.env.DSH_PROFILE_DIR
  if (fromEnv && fromEnv.trim()) {
    // DSH_PROFILE_DIR 指向 .../.dsh/profiles/<name>，取其 ../../ 作为 home 的近似。
    return path.resolve(fromEnv.trim(), '..', '..')
  }
  return path.join(os.homedir(), '.dsh')
}

export function resolveBaseDir(config = {}) {
  const statePath = config.statePath && String(config.statePath).trim()
  if (statePath) return path.dirname(path.resolve(statePath))
  return path.join(resolveHomeDir(), 'dsh-improve-think')
}

function emptyState() {
  return { version: STATE_VERSION, defaults: { ...pickPublicConfig(DEFAULTS) }, sessions: {} }
}

function sanitizeState(raw, fallbackDefaults = {}) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return { ...base, defaults: pickPublicConfig({ ...DEFAULTS, ...fallbackDefaults }) }
  const state = { version: STATE_VERSION, defaults: base.defaults, sessions: {} }
  if (raw.defaults && typeof raw.defaults === 'object') {
    state.defaults = pickPublicConfig({ ...base.defaults, ...raw.defaults })
  }
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [sessionId, value] of Object.entries(raw.sessions)) {
      if (!sessionId || !value || typeof value !== 'object') continue
      const entry = {
        overrides: pickPublicOverrides(value.overrides ?? {}),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        // v1 遗留：整份生效配置；由 migrateLegacyConfigs() 折算成 overrides 后丢弃。
        legacyConfig: value.overrides ? undefined : pickPublicConfig({ ...state.defaults, ...(value.config ?? {}) }),
      }
      state.sessions[sessionId] = entry
    }
  }
  return state
}

export class SessionStateStore {
  constructor(config = {}, options = {}) {
    this.config = normalizeConfig(config)
    /** 可选：实时读取插件条目配置（插件页保存设置后无需重启即可生效）。 */
    this.options = options ?? {}
    this.file = this.config.statePath
      ? path.resolve(this.config.statePath)
      : path.join(resolveBaseDir(this.config), 'state.json')
    const loaded = this.load()
    // 状态文件里记录的默认值先铺底，插件条目配置（设置页）覆盖它：
    // 用户刚在插件页改的值应当立刻成为新会话的默认值。
    this.state = loaded ?? emptyState()
    this.state.defaults = pickPublicConfig({ ...(loaded?.defaults ?? {}), ...pickPublicConfig(this.config) })
    this._timer = null
    this._dirty = false
    this.migrateLegacyConfigs()
  }

  /**
   * v1 → v2：把「整份生效配置」折算成「与当时默认值的差异」。
   *
   * 只有和当时默认值不同的字段才算用户显式改过；这样升级后会话仍保留自己的选择，
   * 而插件页后来改动的其他字段会立刻对老会话生效。
   */
  migrateLegacyConfigs() {
    for (const entry of Object.values(this.state.sessions ?? {})) {
      if (!entry || !entry.legacyConfig) continue
      const overrides = {}
      for (const [key, value] of Object.entries(entry.legacyConfig)) {
        if (value !== this.state.defaults[key]) overrides[key] = value
      }
      entry.overrides = pickPublicOverrides(overrides)
      delete entry.legacyConfig
      this._dirty = true
    }
    if (this._dirty) this.scheduleFlush()
  }

  /** 某个会话显式改过的字段（不含默认值）。 */
  overridesFor(sessionId) {
    const entry = sessionId ? this.state.sessions[sessionId] : null
    return { ...(entry?.overrides ?? {}) }
  }

  /** 插件页当前的默认值（新会话继承它）。 */
  defaultsSnapshot() {
    return pickPublicConfig(this.liveDefaults())
  }

  /** 当前生效的默认值：优先实时读取条目配置，读不到就用构造时的快照。 */
  liveDefaults() {
    const provided = typeof this.options.defaultsProvider === 'function' ? this.options.defaultsProvider() : undefined
    const base = provided === undefined ? this.config : normalizeConfig(provided ?? {})
    return pickPublicConfig({ ...this.state.defaults, ...pickPublicConfig(base) })
  }

  /** 读状态文件；不存在或损坏返回 null（由调用方决定默认值）。 */
  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      return sanitizeState(JSON.parse(text), null)
    } catch {
      return null
    }
  }

  /** 全量落盘；失败只警告，不影响宿主流程。 */
  flushNow() {
    this._dirty = false
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
      return true
    } catch {
      return false
    }
  }

  scheduleFlush(delayMs = 400) {
    this._dirty = true
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      if (this._dirty) this.flushNow()
    }, delayMs)
    // 让进程退出不受影响
    if (typeof this._timer?.unref === 'function') this._timer.unref()
  }

  /** 某个会话的最终配置（插件页默认值 + 会话显式覆盖）。 */
  configFor(sessionId) {
    return normalizeConfig({ ...this.liveDefaults(), ...this.overridesFor(sessionId) })
  }

  /** 写入会话级覆盖片段，返回写入后的完整公开配置。 */
  patchSession(sessionId, patch = {}) {
    if (!sessionId) return this.configFor('')
    const previous = this.state.sessions[sessionId]?.overrides ?? {}
    const overrides = pickPublicOverrides({ ...previous, ...(patch ?? {}) })
    this.state.sessions[sessionId] = { overrides, updatedAt: new Date().toISOString() }
    this.scheduleFlush()
    return this.configFor(sessionId)
  }

  /** 撤掉某几个字段的会话覆盖，让它们重新跟随插件页默认值。 */
  unsetSessionFields(sessionId, keys = []) {
    if (!sessionId) return this.configFor('')
    const entry = this.state.sessions[sessionId]
    if (!entry) return this.configFor(sessionId)
    for (const key of keys) delete entry.overrides?.[key]
    entry.updatedAt = new Date().toISOString()
    if (!Object.keys(entry.overrides ?? {}).length) delete this.state.sessions[sessionId]
    this.scheduleFlush()
    return this.configFor(sessionId)
  }

  /** 重置某个会话到默认值。 */
  resetSession(sessionId) {
    if (!sessionId) return this.configFor('')
    delete this.state.sessions[sessionId]
    this.scheduleFlush()
    return this.configFor(sessionId)
  }

  /** 全局默认值（新会话继承它）。 */
  defaults() {
    return normalizeConfig(this.liveDefaults())
  }

  patchDefaults(patch = {}) {
    this.state.defaults = pickPublicConfig({ ...this.state.defaults, ...(patch ?? {}) })
    this.scheduleFlush()
    return this.configFor('')
  }

  /** 清理长期不用的会话条目，避免状态文件无限增长。 */
  prune(maxSessions = 500) {
    const entries = Object.entries(this.state.sessions)
    if (entries.length <= maxSessions) return 0
    entries.sort((a, b) => String(a[1]?.updatedAt ?? '').localeCompare(String(b[1]?.updatedAt ?? '')))
    const remove = entries.slice(0, entries.length - maxSessions)
    for (const [sessionId] of remove) delete this.state.sessions[sessionId]
    this.scheduleFlush()
    return remove.length
  }

  dispose() {
    if (this._dirty) this.flushNow()
  }
}
