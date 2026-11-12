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
import { DEFAULTS, normalizeConfig, pickPublicConfig } from './core/config.js'

const STATE_VERSION = 1

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
      state.sessions[sessionId] = {
        config: pickPublicConfig({ ...state.defaults, ...(value.config ?? {}) }),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
      }
    }
  }
  return state
}

export class SessionStateStore {
  constructor(config = {}) {
    this.config = normalizeConfig(config)
    this.file = this.config.statePath
      ? path.resolve(this.config.statePath)
      : path.join(resolveBaseDir(this.config), 'state.json')
    const loaded = this.load()
    // 插件条目配置里的值作为"出厂默认"；状态文件里已保存的默认值优先（用户可能在 UI 上改过）。
    this.state = loaded ?? emptyState()
    this.state.defaults = pickPublicConfig({ ...pickPublicConfig(this.config), ...(loaded?.defaults ?? {}) })
    this._timer = null
    this._dirty = false
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

  /** 某个会话的最终配置（会话覆盖 + 默认值）。 */
  configFor(sessionId) {
    const entry = sessionId ? this.state.sessions[sessionId] : null
    return normalizeConfig({ ...this.state.defaults, ...(entry?.config ?? {}) })
  }

  /** 写入会话级配置片段，返回写入后的完整公开配置。 */
  patchSession(sessionId, patch = {}) {
    if (!sessionId) return this.configFor('')
    const previous = this.state.sessions[sessionId]?.config ?? this.state.defaults
    const nextConfig = pickPublicConfig({ ...previous, ...(patch ?? {}) })
    this.state.sessions[sessionId] = { config: nextConfig, updatedAt: new Date().toISOString() }
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
    return normalizeConfig(this.state.defaults)
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
