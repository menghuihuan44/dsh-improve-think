# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.2] - 2026-11-12

### 修复

- **重启后插件无法加载（web 启动页报 "Failed to load plugins"）**：根因是 0.2.1 把 Client 半的
  `inject` 改成了对象形态 `{ required, optional }`。宿主 cordis 的 `inject` 只认**字符串数组**，
  对象会被折成两个名叫 `required` / `optional` 的服务，于是条目永远处于 `pending`
  （`waiting for service: required, optional`），web boot 在挂载 UI 之前就抛
  `web boot: N entries did not activate`，整页无法打开。现在改回
  `['slots', 'locale', 'sessions', 'configForms']`，并在源码里写明这条约束。
  （0.2.1 的说明中"受限 facade 必须声明"的表述不准确：静态加载路径没有那道 guard。）
- 设置面板整段包进 `try/catch`：面板挂载失败只降级为"没有设置页"，不再影响档位条与启动。

## [0.2.1] - 2026-11-12

### 修复

- **插件页看不到设置面板**：Client 半运行在受限 facade 中，只有 `inject` 里声明过的服务才能读取，
  未声明时 `ctx.get(name)` 会被 guard 直接拒绝。此前 `configForms`、`sessions` 未声明，
  读取异常被兜底吞掉，设置面板因此从未注册（`plugins.bundle.config` 无 occupant），
  档位条点击也退化成 `noChannel`。现在 Client 半声明
  `{ required: ['slots','locale'], optional: ['sessions','configForms'] }`。
- 设置面板改为**无条件注册**（不再被试算的 `whileServed` 门控）：宿主没提供 `configForms` 时
  面板如实显示"宿主未提供配置"。表单控制器改为可热切换的稳定数据源（`getSnapshot`/`subscribe`），
  `whileServed` 只负责把控制器切换到 Host 实际服务的 namespace（`include:dsh-improve-think` 或包名）。
- 设置项 `minReasoningChars`、`maxInterruptsPerStep` 补进 `PUBLIC_KEYS`，此前在设置页修改会被静默丢弃。

## [0.2.0] - 2026-11-12

### 变更（Breaking）

- **包名与插件 id 改为 `dsh-improve-think`**（原 `dsh-improve`）。状态目录、日志目录、session projection key
  （`dshImproveThink`）一并改名；从 0.1.x 升级需先卸载旧插件名。
- 仓库结构改为"仓库根即包根"：`lib/`、`locale/`、`test/`、`scripts/`、`package.json` 直接位于仓库根，
  不再套一层 `dsh-improve/` 子目录。

### 新增

- **插件页设置面板**：在 DSH「插件」→ 本插件 → 配置页提供可视化表单（默认档位、三个默认开关、
  空转守护动作与四个阈值），读写 `settings` 服务，保存后写入 profile 配置。
- `Config` schema（schemastery）：13 个字段都带中文说明、默认值与取值范围，DSH 会自动投影成设置表单。
- `peerDependencies: @deepseek-ai/schemastery`；宿主不提供 schemastery 时插件仍可用（只是没有设置表单）。
- 面向模型的 `dsh_improve` 工具：`status` / `tier` / `adversarial` / `idleGuard` / `firstTurnFast` /
  `observe` / `interrupt` / `reset`，与 `/improve` 命令、UI 档位条共用同一份 Host 实现。
- 文档：`docs/DESIGN.md`（设计与边界）、`docs/EXTENSION-POINTS.md`（扩展点与降级矩阵）、
  `CONTRIBUTING.md`、`.github/workflows/ci.yml`（Node 22/24 上跑单测与自测）。

### 修复

- UI 写回不再假定存在连接级 `remote`：按 `sessions.binding(id).session.command` →
  `sessions.scope(id).remote.commands.execute` → `ctx.get('remote').commands.execute` 三级回退。
- 插件在 session 中途加载时收到的"幽灵 step"（只有 `step/end` 没有 `step/start`）不再被评估、不再刷日志。
- `plugin.loaded` 能力字段只反映"注册发起"，最终能力改由 `capabilities.ready`（注入收尾或 1.5s 兜底）补记。
- 流内打断的"第一步不掐"判据改为"没有已完成的对照基线"，修掉原先因 `streak` 恒为 0 导致永不触发的缺陷。

## [0.1.1] - 2026-11-12

### 新增

- `dsh_improve` 工具注册；`/improve status` 增加四项能力诊断行。
- `capabilities.ready` 日志事件（注入收尾后补记最终能力）。
- Client 写回三通道回退（`session.command` / scoped remote / 连接级 remote）。

### 修复

- 幽灵 step 不评估；纯空观测不写 `idle.observe`。
- 流内采样起点改为 `min(minReasoningChars, SAMPLE_STRIDE)`，短推理也能被采样。
- `llm/stream` 里把 text/reasoning 累积进 step 观测，避免 `step/end` 评估时拿不到文本。

## [0.1.0] - 2026-11-12

### 新增

- 输入框下方档位条：思考档（常规/严格/极致）、对抗开关、空转守护、首轮快跳。
- 全轮次空转守护：`llm/stream` 流内检测与提前收尾、`session/event` 轮次账本、`followup` 注入纠正提示。
- 路线校准软规范（`systemPrompt.section`，order 46）与首轮快跳约束。
- 按会话持久化状态（插件私有 JSON）、JSONL 复盘日志、能力降级显式报告。
