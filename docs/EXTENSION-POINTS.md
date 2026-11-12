# 扩展点与降级矩阵

本文件记录插件依赖的每一个 DSH 扩展点、它的确切签名、缺失时的行为，以及**怎么验证**。
环境基线：DSH `0.2.2-rc.1`、Node `^22.19.0 || >=24.0.0`。

## 1. 矩阵

| 能力 | 扩展点 | 签名（关键部分） | 缺失时 |
| --- | --- | --- | --- |
| 流内推理拦截 | `llm/stream`（waterfall） | `(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>` | 降级为轮次后检测：从 `session/event` 的 `assistant/message` 读已组装回复 |
| 行为规范注入 | `systemPrompt.section` | `section({ name, order, text: (ctx) => string }): () => void` | 无降级（必需能力） |
| 轮次账本 | `session/event`（observe） | `(session, event)`；事件 `turn/start{turn}`、`step/start`、`step/end{turn,step}`、`tool/call`、`assistant/message`、`turn/end{turn,reason}` | 无降级（必需能力） |
| 工具调用记账 | `tools/pre-execute`（waterfall） | `(exec, next) => Promise<{kind:'allow'|'deny'|'cancel'|'ask'}>`，**必须 return** | 仍可用 `session/event` 的 `tool/call` |
| 抓 live agent | `agent/created`（serial）/ `agent/pre-step`（waterfall） | `({ agent, ... })` | 退到 `agents.get(sessionId)` |
| 纠正提示送达 | `Agent.followup(message)` | 同步、无返回；入参必须是完整 message `{id, role:'user', content, source}` | 记 `resume.skipped` 日志，不伪造送达 |
| 会话命令 | `commands.register` | `register({ name, description, recordInput, handler(invocation) })` | UI 报错（不静默失效） |
| 模型侧工具 | `tools.register` | `register({ name, description, parameters, output, execute })` | 退到 `/improve` 命令 |
| Client 读状态 | `sessionProjections.register` + `wire.view` | `{ key, stateVersion, stateSchema, init, apply, wire: { viewSchema, view } }` | UI 只显示开关，标记退化到日志/`status` |
| Client 写状态 | `ISession.command` | `sessions.binding(id)?.session?.command(line)` | 退到 `sessions.scope(id).remote.commands.execute`，再退到 `ctx.get('remote').commands.execute` |
| 插件页设置 | `settings` 服务 + `ctx.configForms` | `configForms.get('include:dsh-improve-think')` → `{getSnapshot, set, unset, whileServed}` | 设置面板不注册（不显示空白卡），其余功能不受影响 |
| 设置 schema | schemastery `Config` export | `export const Config = z.object({...})` | 插件仍加载（`Config === undefined`），只是没有表单 |

## 2. 四个容易踩的坑

1. **`host.call` 不存在于已安装 npm 包**。它属于"动态双半包"（Host 代码以字符串形式进沙箱执行）的能力，
   Host 侧只有 `harness.handle(method, fn)` 一种注册方式。普通插件要跨半通信，用 `commands` 或自定义 typert remote。
2. **没有 `wire.view` 的投影不会推给 Client**。只声明 `key/stateVersion/stateSchema` 不够，
   Client 的 `useProjection(key)` 读的是 `wire.view(state)` 的返回值。
3. **`session/event` 是 observe-only**：监听器不能改事件，也不能靠它追加新 type 的 session event
   （重开会话时会被拒绝）。想持续化状态请用插件私有 JSON 或 storage 服务。
4. **Client 半是受限 facade：没在 `inject` 里声明的服务读不到**。未声明时 `ctx.get(name)` 会被 guard
   直接拒绝并抛错；如果代码用 `try/catch` 兜底，就会静默退化成"功能消失"。本插件曾因此**设置面板整块不出现**。
   写法：`{ required: ['slots','locale'], optional: ['sessions','configForms'] }`——必需的进 required，
   可有可无的进 optional（宿主缺对应 UI 半时降级，而不是整个插件挂起）。

   另外两个与设置页相关的必要条件：
   - Config 的**每个字段都要 `.volatile()`**，否则 `settings.describe()` 的 `volatileForm()` 会把整个条目过滤掉；
   - `plugins.bundle.config` 的 cell key 必须是**包名**，且最好无条件注册（不要被试算的门控挡住），
     否则插件页会整块没有"配置"。
   - `settings.describe()` 只在条目 fiber 回到 active 后才列出该 namespace；插件刚加载的瞬间查询会得到
     `missing`，属于时序假象（本插件为此补记一条 `settings.form.checked` 日志）。

## 3. 自己的环境怎么验证

装好插件后，在任意会话里：

```
/improve status
```

应看到六行诊断（节选）：

```
流式拦截：可用
诊断：stream=已观察到 llm/stream  投影=已注册  命令=已注册  工具=已注册
设置页：已开放（dsh-improve-think，13 个字段）
```

日志目录（默认 `<DSH 配置根>/dsh-improve-think/logs/`）：

- `global.jsonl`：`plugin.loaded`（注册发起时的保守能力）、`capabilities.ready`（注入收尾或 1.5s 兜底后的**最终**能力）、
  `settings.form.checked`（延迟复查设置页是否真的被 `settings.describe()` 服务）；
- `<sessionId>.jsonl`：该会话的 `turn.start` / `idle.*` / `route.goal-check.scheduled` / `resume.followup` / `degrade.*`。

若 `capabilities.ready` 里 `projection` / `commands` / `tools` 为 `false`，说明当前版本缺少对应服务——
插件会按第 1 节的"缺失时"列降级，并在 UI 上标注，不会假装成功。
