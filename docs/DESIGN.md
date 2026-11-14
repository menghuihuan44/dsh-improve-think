# 设计说明

> 一句话定位：**给"雷霆大思考"装一个只认证据的刹车，而不是给推理总成限速。**

## 1. 问题

长任务里失败的方式通常不是"想得不够久"，而是两种：

1. **只想不做**：反复输出"好、做、执行、收到"，或把同一结论重述三遍，既不调工具也不产出改动；
2. **默默跑偏**：轮次越走越远，直到交付时才发现做的不是用户最初要的东西。

反过来，粗暴的"限制思考时长 / 全局降 reasoning_effort"会误伤真正的探索性推理——那是这个插件明确要避免的。

## 2. 三条设计原则

| 原则 | 落地方式 |
| --- | --- |
| 只拦"重复且无进展" | 打断条件是**可检测信号**（短句空话、推理尾部相似度、结论复发、零产出），不是时长或 token 数 |
| 不确定就放行 | 判定表的兜底分支是 `inconclusive-release`；`unknown`（失败/零输出/信息不足）一律不动作 |
| 降级必须可见 | 缺 `llm/stream` 时显式写 `degrade.no-stream-hook`，并在 UI 与 `/improve status` 标注"无流内打断" |

第三条尤其重要：**静默失效的守护比没有守护更危险**，因为它会让人误以为已被保护。

## 3. 组成

```
Host 半 (lib/index.js)
├─ systemPrompt.section(order 46)   ── 路线校准 / 档位规范 / 首轮快跳（软约束）
├─ llm/stream (waterfall)           ── 流内看 reasoning-delta，重复则提前收尾
├─ session/event (observe)          ── turn/step/tool/call/assistant/message 账本
├─ tools/pre-execute                ── 工具调用记账（证明"有进展"）
├─ agent/created + agent/pre-step   ── 抓 live agent，供 followup 送达提示
├─ commands.register('improve')     ── 会话命令（UI / 人手 / 脚本）
├─ tools.register('dsh_improve')    ── 同一个实现的模型侧入口
├─ sessionProjections.register      ── wire.view 推给 Client
└─ Config (schemastery)             ── 插件页设置表单

Client 半 (lib/client.js)
├─ conversation.input.dock          ── 输入框上方全宽档位条
└─ plugins.bundle.config            ── 插件页设置面板（读 ctx.configForms）
```

数据流：

```
                 ┌──────────── Client ────────────┐
 点击档位条 ────► │ sessions.binding(id)            │
 插件页保存 ────► │   .session.command('/improve …')│ ──► Host commands.execute
                 │ ctx.configForms.get(entry).set()│ ──► Host settings.mutate
                 └────────────┬───────────────────┘
                              │ wire.view 投影（key=dshImproveThink）
                 ┌────────────┴───────────┐
 档位条渲染 ◄──── │ useProjection(key)     │
                 └────────────────────────┘
```

**为什么写回走 `commands` 而不是私有 RPC**：已安装的普通 npm 插件没有 `host.call`
（那是"动态双半包"沙箱才有的 `harness.handle` 通道），见 `docs/EXTENSION-POINTS.md`。

## 4. 判定状态机

每一步（step）结束时用 `evaluateStep` 打分，按下面的优先级短路：

| 顺序 | 条件 | 判定 | 动作 |
| --- | --- | --- | --- |
| 1 | step 出错 / 被中止 | `unknown` | 放行 |
| 2 | 有工具调用、代码变更、新增计划条目 | `progress` | 放行，streak 归零 |
| 3 | 有新文本且不是结论复发 | `progress` | 放行 |
| 4 | 只有空话 / 结论复发 / 推理尾部重复 | `non-progress` | streak +1 |
| 5 | 零输出（无文本无推理无工具） | `unknown` | 放行 |
| 6 | 其它（信息不足） | `progress`（inconclusive-release） | 放行 |

`streak >= stagnationCount` 才升级：

- `observe`：写 `idle.observe`，在投影里标记"疑似空转"，**不打断**；
- `interrupt`：轮次后检测到则写 `idle.interrupt` 并 `followup` 送纠正提示；流内检测到则写
  `idle.interrupt.stream` 并提前收尾。

### 4.1 流内打断为什么更严

流内看不到"这一步最终会不会调工具"，所以额外要求：

- 当前 step **没有任何 tool-call delta**（一旦出现立刻放弃打断）；
- 推理长度 ≥ `minReasoningChars`；
- 尾部相似度 ≥ `reasoningSimilarityThreshold`，或命中已记录的结论签名；
- **至少已有一个已完成的 step 作为对照基线**（会话第一步绝不掐）。

收尾方式是先闭合当前块再 `yield {type:'finish', reason:{kind:'stop'}}`，不是 `error`：

- 已放行的 chunk 会作为"截断的完整回复"正常落盘；
- 会话不会被标成错误态；
- 随后用 `agent.followup(消息)` 唤醒下一轮送达纠正提示，**不终止会话、不清空上下文**。

## 5. 状态与持久化

两层，刻意分开：

| 层 | 存放位置 | 作用 |
| --- | --- | --- |
| 插件默认值 | profile 配置（`cordis.patch.yml` 里本条目）+ `Config` schema | 新会话的出厂默认，插件页可改 |
| 每会话覆盖 | `<DSH 配置根>/dsh-improve-think/state.json` | 档位条 / `/improve` 的实时选择，重启不重置 |

**为什么不把每会话状态塞进 profile 配置**：改 profile 配置会触发插件重启，用户点一下档位条就重载插件，
显然不可接受。所以每会话状态用插件私有 JSON（原子写：临时文件 + rename），最多保留 500 个会话。

## 6. 两处裁定

1. **`idleGuardAction` 默认 `interrupt`**。需求文档 §一.2 写"默认 interrupt；用户显式开启 observe 后才不会
   实际流内中断"，§三.2 又写"默认 observe"。本插件按 §一.2 实现，因为它是配置项定义处；
   `observe` 作为显式降级选项保留（`/improve observe`、`dsh_improve {action:"observe"}`、插件页下拉）。
2. **没有"临时降 reasoning_effort"路径**。当前 DSH 版本没有按轮次调整 `reasoning_effort` 的受支持扩展点
   （`llm/stream` 拿到的是冻结请求，只能观察流）。所以日志里永远不会出现 `effort.temp-lowered`——
   这是有意的，不是缺失。将来若有受支持扩展点，约定是：只在空转信号明确时临时降档，下一轮必须恢复，并记日志。

## 7. 明确不做的事

- 不修改 `reasoning_effort`、不改 `agent/request`、不动 system prompt 之外的请求内容；
- 不以 token 数、时长、轮数上限作为打断依据；
- 不在流内打断"带工具调用"的推理；
- 不对子代理做特殊豁免或特殊加严（当前对所有会话一视同仁）；
- 不静默失效：能力缺失一律写日志 + 在 UI/`status` 体现。
