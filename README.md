# dsh-improve-think

> 思考档 + 空转守护 + 路线校准：**只拦"反复无进展"，不拦"想得深"**。

`dsh-improve-think` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的双半插件（Host + Web UI）。
它在输入框下方加一条轻量档位条、在 DSH「插件」页提供一份可视化设置，并在一整轮会话里守护"空转"。

它**不**做这些事：

- ❌ 不全局改 `reasoning_effort`，也不因为切档降低推理强度；
- ❌ 不以"推理时间长"为理由打断；
- ❌ 不拦截带工具调用、代码变更、多步规划的正常推理；
- ❌ 不确定时默认放行（宁可漏拦，不要误伤）。

它做的是：只在检测到"反复无进展"的信号时，注入一句简短纠正提示，然后让任务继续跑。

- 📖 设计与边界：[`docs/DESIGN.md`](docs/DESIGN.md)
- 🔌 扩展点与降级：[`docs/EXTENSION-POINTS.md`](docs/EXTENSION-POINTS.md)

---

## 1. 安装

```bash
git clone https://github.com/menghuihuan44/dsh-improve-think.git
```

然后在 DSH 会话里用 `plugin_manager` 安装这个目录（会改动 profile，需要审批）：

```
plugin_manager({ action: "install_bundle", target: "<克隆下来的绝对路径>" })
```

安装后按提示重载插件 / 重启 DSH；UI 半边是浏览器 bundle，**需要刷新页面**才会出现档位条与设置面板。

要求：DSH `>= 0.2.2-rc.1`、Node `^22.19.0 || >= 24.0.0`。

> 从 0.1.x（旧名 `dsh-improve`）升级：先 `remove_bundle target=dsh-improve`，再按上面安装新名字。

## 2. 三个入口

同一个操作有三个入口，共用同一份 Host 实现，不会出现"UI 改得动、模型改不动"的分叉：

| 入口 | 位置 | 适用 |
| --- | --- | --- |
| 档位条 | 输入框上方全宽一行（`conversation.input.dock`） | 日常切换当前会话的档位与开关 |
| 插件页设置 | DSH「插件」→ dsh-improve-think → 配置 | 改**默认值**（新会话生效），重启后仍在 |
| `/improve` 命令 + `dsh_improve` 工具 | 会话输入框 / 模型自身 | 手动排障、让模型自己切档 |

## 3. 档位条

| 控件 | 取值 | 默认 |
| --- | --- | --- |
| 思考档 | 常规 / 严格 / 极致 | 常规 |
| 对抗开关 | 开 / 关 | 关 |
| 空转守护 | 开 / 关 | **开** |
| 首轮快跳 | 开 / 关 | **开** |

状态按会话持久化：写在 `<DSH 配置根>/dsh-improve-think/state.json`，重开应用不会重置。
（路径优先级：插件配置 `statePath` > `DSH_HOME` > `$DSH_PROFILE_DIR/../..` > `~/.dsh`。）

检测到"疑似空转"时，条上出现 `⚠ 疑似空转`（悬停看原因）；缺少流式拦截能力时出现 `· 无流内打断`。

## 4. 插件页设置

**DSH「插件」→ dsh-improve-think → 配置**，可直接改下面这些（保存进 profile 配置，重启后仍在）：

| 字段 | 默认 | 取值范围 | 说明 |
| --- | --- | --- | --- |
| 默认思考档 | 常规 | 常规 / 严格 / 极致 | 新会话使用的档位 |
| 对抗审查 | 关 | 开 / 关 | 动手前查反例与代价，交付前查目标偏离 |
| 空转守护 | 开 | 开 / 关 | 总开关 |
| 首轮快跳 | 开 | 开 / 关 | 首轮先给可执行计划 |
| 检测到空转时 | 流内中断 | 只记录 / 流内中断 | `observe` 只写日志不打断 |
| 停滞轮数阈值 | 3 | 2–20 | 连续多少轮无进展才判定空转 |
| 推理尾部相似度 | 0.80 | 0.50–0.98 | 越高越宽松 |
| 目标对照间隔 | 5 | 1–50 | 每隔多少轮做一次路线校准 |
| 最短判定推理字数 | 80 | 20–2000 | 太短的推理不参与判定 |
| 每步最多中断次数 | 1 | 0–3 | 防止同一步反复被打断 |

表单直接读写 DSH 的 `settings` 服务（`ctx.configForms`），点选即保存，全部字段带说明与范围校验；
底部「全部恢复默认」逐字段 `unset`，回落到插件内置默认值。

> 设置面板只改**默认值**。当前会话的实时档位仍由档位条 / `/improve` 覆盖，两者互不打架：
> 默认值 → 新会话起点，会话覆盖 → 该会话的当前值。

**看不到设置表单？** 按顺序排查：

1. **刷新页面**。Client 半是浏览器端 bundle，重装插件后必须刷新才会加载新代码。
2. 用 `/improve status` 看第 6 行：`设置页：已开放（<namespace>，13 个字段）` 才算 Host 已开放。
   显示「未开放」说明本插件条目没进 `settings.describe()`——Config 的每个字段都必须带
   `.volatile()`（本仓库已全部带上）；显示「无法查询」说明宿主没提供 `settings` 服务。
3. 宿主日志 `~/.dsh/dsh-improve-think/logs/global.jsonl` 里搜 `settings.form.checked`：
   `status:"served"` 即表示 Host 侧确实在服务这个 namespace（`capabilities.ready` 里的
   `settingsForm` 是加载瞬间的快照，太早，可能误报 `missing`）。
4. Client 半运行在受限 facade 里：**凡要读的服务必须在 `inject` 声明**，否则读取会被 guard
   拒绝、功能静默消失。本插件声明了 `{ required: ['slots','locale'], optional: ['sessions','configForms'] }`。

## 5. 配置项（`cordis.patch.yml` 条目 options）

与 §4 表单同源，也可以用配置方式给：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tier` | `normal` | `normal` / `strict` / `extreme` |
| `adversarial` | `false` | 对抗审查开关 |
| `idleGuard` | `true` | 空转守护总开关 |
| `firstTurnFast` | `true` | 首轮快跳 |
| `idleGuardAction` | `interrupt` | `observe` / `interrupt` |
| `stagnationCount` | `3` | clamp 2..20 |
| `reasoningSimilarityThreshold` | `0.8` | clamp 0.5..0.98 |
| `goalCheckInterval` | `5` | clamp 1..50 |
| `minReasoningChars` | `80` | 太短的推理不判定 |
| `maxInterruptsPerStep` | `1` | 单步最多打断次数 |
| `log` | `true` | 是否写 JSONL 日志 |
| `logDir` / `statePath` | `''` | 覆盖日志/状态路径（一般不用） |

需求文档里 §一.2（"默认 interrupt"）与 §三.2（"默认 observe"）冲突，本插件按 **§一.2** 实现：
默认 `interrupt`，`observe` 是用户显式选择的降级模式。理由见 [`docs/DESIGN.md`](docs/DESIGN.md) §6。

## 6. 思考档 = 行为规范档（不是推理强度开关）

四个档位只影响**注入的行为规范文本**，不影响任何模型/推理参数：

- **常规**：不额外增加确认步骤；只在检测到空转信号时介入。
- **严格**：动手前简短列出"目标 / 假设 / 回滚方案"三行；交付前做一次简短自我检查。**不要求长篇复述**。
- **极致**：在严格档基础上增加对抗审查——动手前审查方案的反例与代价；交付前审查是否偏离用户最初目标；
  循环模式下每轮审查改动。
- **极致 + 对抗**：把"反例 / 代价 / 偏离"从建议提升为必答项。

本插件**不修改** `reasoning_effort`。当前 DSH 版本没有"按轮次动态调整 `reasoning_effort`"的受支持扩展点
（`llm/stream` 拿到的是冻结请求）；即使将来有，约定也是"仅在空转信号明确时临时降档、下一轮必须恢复、并记日志"。
所以日志里不会出现 `effort.temp-lowered`——这是有意为之。

## 7. 空转守护（核心）

### 7.1 检测的信号

1. 连续多次只输出"好 / 做 / 执行 / 收到"这类无实质进展短句；
2. 推理文本尾部出现重复周期，相似度 ≥ `reasoningSimilarityThreshold`；
3. 连续多轮没有产生工具调用或可见产出；
4. 同一结论被反复重述，且没有新增计划、工具调用或代码变更。

### 7.2 判定顺序（保守优先）

```
失败/异常 step              → UNKNOWN（放行）
有工具调用/代码变更/新增计划 → PROGRESS
新文本且非结论复发          → PROGRESS
空话 / 结论复发 / 推理尾部重复 → NON_PROGRESS（累计 streak）
零输出                      → UNKNOWN（放行）
其它                        → inconclusive-release（放行）
```

`streak >= stagnationCount` 才动作：`observe` 只写日志 + 标记；`interrupt` 注入纠正提示并让任务继续。

### 7.3 流内打断的真实边界

- 走 `llm/stream`（waterfall），可以看 `reasoning-delta`，也可以在重复时提前收尾（`finish{kind:'stop'}`）。
- 触发比轮次后检测更严：**当前 step 没有任何 tool-call delta**、推理 ≥ `minReasoningChars`、
  相似度 ≥ 阈值或命中结论签名，且**至少已有一个已完成的 step 作对照基线**（会话第一步绝不掐）。
- 收尾方式是先闭合当前块再 `finish{kind:'stop'}`——不是 `error`，已产出内容照常落盘，会话不会进错误态。
- 打断后用 `agent.followup(消息)` 唤醒下一轮送达纠正提示，**不终止会话、不清空上下文**。

> 这是"打断一次思考"，不是"打断任务"。

## 8. 首轮快跳

首轮注入一条轻量约束（`systemPrompt.section`，只在 `turn <= 1` 出现）：

> 首轮先快速形成可执行计划并开始行动，不要在未读取上下文前闭门造车；后续轮次仍可进行深度推理。

只作用于首轮策略提示，**不关闭后续深度推理、不降低任何档位**；首轮已有工具调用时不会额外打断。

## 9. 路线校准（软规范）

`systemPrompt.section({ name: 'dsh-improve-think/route-calibration', order: 46 })`，
位于 persona（order 0）之后、计划策略（500）与工具引导（≥1000）之前。

- **SHOULD**：每隔 `goalCheckInterval` 轮对照用户最初目标；发现偏移先说明偏移点，再纠正。
- **CAN**：目标明确时可以大胆重构、扩展、创新，不必为每个小改动征求确认。
- **MUST NOT**：不得在无实质进展的循环里反复输出相同内容；不得用"我在思考"替代可执行动作。
- **SHOULD NOT**：不得因为"怕想太多"而跳过必要的方案对比和风险检查；不得因为空转守护而不敢深度推理。

提示词里明确写了"空转守护只拦重复且无新进展，不拦深度探索"，避免模型畏缩。
第 N 轮（N = `goalCheckInterval` 整数倍）结束后通过 `followup` 送达 1~2 行的目标对照请求，而不是等到任务结束才提醒。

这段规范是**软约束**；真正兜底的是 §7 的 Hook 检测。

## 10. 命令与工具

```
/improve                    # 查看当前档位与状态
/improve tier strict        # normal | strict | extreme
/improve adversarial on     # on/off，省略值=切换
/improve idleGuard off
/improve firstTurnFast off
/improve observe            # 空转动作 = 只记录
/improve interrupt          # 空转动作 = 流内打断（默认）
/improve reset              # 恢复默认
```

模型侧同一个实现暴露为工具：

```
dsh_improve { "action": "status" }
dsh_improve { "action": "tier", "value": "extreme" }
dsh_improve { "action": "idleGuard", "value": "off" }
```

## 11. 扩展点与降级

| 能力 | 扩展点 | 缺失时 |
| --- | --- | --- |
| 流内推理拦截 | `llm/stream`（waterfall） | 降级为"轮次后检测"：从 `assistant/message` 读已组装回复 |
| 工具记账 | `session/event` 的 `tool/call` + `tools/pre-execute` | 仍可用 `session/event` |
| 规范注入 | `systemPrompt.section` | 无降级（必需能力） |
| 轮次/步边界 | `session/event` | 无降级 |
| 纠正送达 | `agent.followup(message)` | 记 `resume.skipped`，不伪造送达 |
| UI 写回 | `ISession.command` → scoped remote → 连接级 remote | 三级都不可用则在 UI 报错，不静默失效 |
| 插件页设置 | `settings` + `ctx.configForms` | 不注册面板，其余功能不受影响 |

降级**显式报告**：连续 3 个 step 没观察到 `llm/stream` 数据时写 `degrade.no-stream-hook`，
并在 `/improve status` 与 UI 标注"流内打断不可用（已降级）"。
完整签名与验证方法见 [`docs/EXTENSION-POINTS.md`](docs/EXTENSION-POINTS.md)。

## 12. 日志

默认写到 `<DSH 配置根>/dsh-improve-think/logs/<sessionId>.jsonl`（单文件超 512KB 滚动成 `.1`）：

| 事件 | 含义 |
| --- | --- |
| `plugin.loaded` | 插件加载（此时注入还没收尾，能力字段可能偏保守） |
| `capabilities.ready` | 注入收尾（或 1.5s 兜底）后补记的**最终**能力 |
| `turn.start` | 每轮开始（含当前档位） |
| `idle.observe` | 观察到疑似空转（observe 模式：只记录） |
| `idle.interrupt` | 轮次后判定空转并注入纠正 |
| `idle.interrupt.stream` | 流内判定重复并提前收尾（含相似度与推理长度） |
| `route.goal-check.scheduled` | 到达目标对照轮次 |
| `resume.followup` | 通过 followup 把纠正/目标对照送达并继续 |
| `config.patch` / `config.reset` | 档位变更 |
| `degrade.no-stream-hook` | 缺少流式拦截点，已降级 |

目的是**可复盘**：每次打断都能回答"为什么打断、相似度多少、打断后怎么继续"。

## 13. 自测

```bash
npm run check      # 语法检查
npm test           # 28 条 core 单测 + 9 组 client 渲染/接线断言
npm run selftest   # 10 条验收场景（假 Cordis ctx 驱动真实插件代码）
```

三套测试都不需要网络、不需要启动 DSH、不需要模型。

`npm run selftest` 覆盖：

1. **空转模拟**：连续只输出"好"——observe 只记录；interrupt 打断并注入纠正，任务继续；
2. **正常复杂任务**：12 轮多步工具调用 + 长推理，零误打断；
3. **首轮快跳**：首轮注入约束，第 2 轮起不再注入且仍保留深度推理；
4. **对抗审查**：极致档 + 对抗下有反例/代价/偏离审查，`tools/pre-execute` 仍返回 `allow`（不阻塞工具）；
5. **路线校准**：`goalCheckInterval=3` 时在第 3、6 轮结束就提醒；
6. **降级说明**：没有 `llm/stream` 时记录 `degrade.no-stream-hook` 并走 `assistant/message` 兜底；
7. **流内打断**：重复推理提前收尾（`finish=stop`）并 followup 继续；
8. **UI 接线**：投影 key/stateVersion/schema/wire 正确、命令写回后投影一致；
9. **工具/幽灵步/能力补记**：`dsh_improve` 与命令同源、非法输入报错、无 `step/start` 的幽灵步不评估、
   `capabilities.ready` 如实补记；
10. **设置 schema 降级**：宿主不提供 schemastery 时插件仍可用（不崩、不谎报）。

`npm test` 的 client 部分另外验证：模块 id 等于包名、注册 `conversation.input.dock`、
投影渲染（含"疑似空转/降级"标记）、点击首选 `ISession.command`、缺 `sessions` 时退到 `remote.commands.execute`、
无 `sessionId` 不发命令、插件页设置面板的注册/读快照/写回/恢复默认、缺 `configForms` 时不注册空面板。

## 14. 真实环境验证记录

环境：desktop profile、dsh `0.2.2-rc.1`、Node `v26.13.0`；以 `plugin_manager install_bundle`（`link:` 形式）挂载。

| 验证点 | 真实证据 |
| --- | --- |
| 系统提示词注入 | 会话系统提示词里出现「## 路线校准」「## 首轮快跳」两段原文 |
| 档位动态生效 | 切极致档后立刻多出「思考档：极致（动手前 / 交付前）」；`reset` 后消失 |
| 能力探测 | `capabilities.ready {reason:"injections-settled", streamIntercept:true, projection:true, commands:true, tools:true}` |
| 流式拦截 | `stream.observed` 记录 `provider=… model=… reasoningEffort=high`——拦到真实请求，且**未改动** `reasoning_effort` |
| 模型侧工具 | `dsh_improve` 出现在真实会话工具列表，`status` / `tier extreme` / `reset` 实测成功 |
| 会话内持久化 | `state.json` 出现本会话 `config.tier="extreme"`；reset 后清空 |
| UI 挂载 | `conversation.input.dock` occupants 含 `dsh-improve-think (order 10, active:true)` |
| 不误伤 | 277 个 step、328 次工具调用的深度工作期间 `idle.observe` 0 条、`idle.interrupt` 0 条 |

两点环境事实：

- **Client 半是浏览器 bundle**：升级后要刷新页面才会加载新 `client.js`；Host 半在插件重载后生效。
- **真实"空转复发"未在自然对话中触发**：真实模型不会主动进死循环，构造它要烧大量 token；
  这条路径由 `npm run selftest` 用真实 chunk / 事件形状验证（场景 1、7）。真实环境目前证明的是"不误伤"那一侧。

## 15. 已知限制

1. `llm/stream` 是 `LlmRuntime` 上的 waterfall：插件只能观察/短路流，**不能修改**已冻结的请求
   （不改 system prompt、不改 tools）。所以行为规范走 `systemPrompt.section`，而不是改请求。
2. 推理（reasoning）是否流式可见取决于适配器。只给 text 的模型上，相似度这条信号不生效，
   只剩"空话 / 结论复发 / 无产出"三条——属于"信息不足 → 放行"的预期行为。
3. 打断后能否真正继续，取决于 agent 是否 live、模型是否愿意接受纠正提示；插件保证的是
   "不终止会话、不丢上下文、把提示送达"，不保证模型一定照做。
4. 每 step 最多打断 `maxInterruptsPerStep` 次；子代理会话同样受守护（未做特殊豁免）。
5. 设置面板改的是默认值；想改"当前会话"仍需档位条 / `/improve`。
6. 面板要出现在插件页，需要 `plugins.bundle.config` 里存在 key = 包名的 cell；本插件**无条件注册**
   该 cell，因此即使宿主没提供 `configForms`，页面上也会出现「设置」区块并如实说明不可用，
   而不是整块消失。
7. **Client 半的 `inject` 必须是字符串数组**：宿主 cordis 会把 `inject` 折成 `{ 服务名: 拦截器 }`，
   每个 key 都是它要等的服务。写成 `{ required: [...], optional: [...] }` 会被折成两个名叫
   `required` / `optional` 的服务，条目永远 `pending`，web boot 直接报
   `web boot: N entries did not activate` 并且整页打不开（0.2.1 的启动崩溃就是这条）。
   `package.json` 里的 `dsh.client.inject` 同理，必须是字符串数组。

## 16. 目录

```
.
├── package.json              # dsh.bundle.patch + dsh.client{platform:web} + peerDeps(schemastery)
├── cordis.patch.yml          # insert: dsh-improve-think
├── icon.svg
├── locale/{zh,en}.json       # meta.title / meta.description
├── lib/
│   ├── index.js              # Host 半：hooks、命令、工具、投影、Config schema
│   ├── client.js             # Client 半：档位条 + 插件页设置面板
│   ├── core/text.js          # 文本信号（相似度 / 空话 / 结论签名 / 计划计数）
│   ├── core/config.js        # 配置默认值与归一化
│   ├── core/stagnation.js    # 空转判定状态机
│   ├── core/prompts.js       # 路线校准 / 档位规范 / 首轮快跳文本
│   ├── state-store.js        # 按会话持久化（插件私有 JSON）
│   └── logger.js             # JSONL 日志
├── test/core.test.mjs        # 状态机与纯函数单测
├── test/client.test.mjs      # Client 半渲染与接线（假 React + 假 ctx）
├── scripts/selftest.mjs      # 10 条验收场景
├── docs/DESIGN.md            # 设计与裁定
├── docs/EXTENSION-POINTS.md  # 扩展点与降级矩阵
├── CHANGELOG.md
└── .github/workflows/ci.yml  # Node 22 / 24
```

## 贡献与许可

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；提交前跑 `npm run check && npm test && npm run selftest`。
[MIT](LICENSE) © 2026 dsh-improve-think contributors
