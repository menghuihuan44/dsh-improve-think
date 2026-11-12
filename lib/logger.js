/**
 * 日志：所有"打断 / 观察标记 / 目标对照 / 临时降档尝试 / 降级说明"都要留痕，方便用户复盘。
 *
 * 写 JSON Lines，按会话分文件，单文件超过上限就滚动成 .1。
 * 任何 IO 失败都静默吞掉——守护插件不能因为写日志把宿主搞崩。
 */

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 512 * 1024

export class ImproveLogger {
  /**
   * @param {object} params
   * @param {string} params.dir 日志目录
   * @param {boolean} [params.enabled]
   * @param {number} [params.maxBytes]
   * @param {(level: string, message: string) => void} [params.sink] 宿主 logger 镜像
   */
  constructor({ dir, enabled = true, maxBytes = DEFAULT_MAX_BYTES, sink } = {}) {
    this.dir = dir
    this.enabled = enabled
    this.maxBytes = maxBytes
    this.sink = sink
    this._dirReady = false
  }

  setDir(dir) {
    this.dir = dir
    this._dirReady = false
  }

  fileFor(sessionId) {
    const safe = String(sessionId || 'global').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'global'
    return path.join(this.dir, `${safe}.jsonl`)
  }

  ensureDir() {
    if (this._dirReady) return true
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      this._dirReady = true
      return true
    } catch {
      return false
    }
  }

  rotateIfNeeded(file) {
    try {
      const stat = fs.statSync(file)
      if (stat.size < this.maxBytes) return
      fs.renameSync(file, `${file}.1`)
    } catch {
      /* 文件不存在或不可读：忽略 */
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} event 事件名，如 idle.observe / idle.interrupt / route.goal-check
   * @param {Record<string, unknown>} [data]
   */
  log(sessionId, event, data = {}) {
    const record = { at: new Date().toISOString(), sessionId: sessionId || null, event, ...data }
    if (this.sink) {
      try {
        this.sink('info', `[dsh-improve-think] ${event} ${JSON.stringify(data)}`)
      } catch {
        /* ignore */
      }
    }
    if (!this.enabled) return record
    if (!this.ensureDir()) return record
    const file = this.fileFor(sessionId)
    this.rotateIfNeeded(file)
    try {
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* ignore */
    }
    return record
  }

  /** 读取最近若干条日志（供调试命令/自测用）。 */
  tail(sessionId, limit = 50) {
    try {
      const text = fs.readFileSync(this.fileFor(sessionId), 'utf8')
      const lines = text.trim().split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, limit)).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { raw: line }
        }
      })
    } catch {
      return []
    }
  }
}
