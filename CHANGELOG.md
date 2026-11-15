# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.2] - 2026-11-15

### 修复

- **决策选项框太大，一弹出来几乎盖住半屏**：原来每个选项都是整行卡片
  （标题 + 副标题 + 内边距），「其它」输入区还常驻一个两行文本框。现在：
  - 选项压成一排可换行的 chip（编号 + 方向名 + 淡色代价，单行 26px），
    最多两行高，超出部分在框内滚动；
  - 「其它」变成一个虚线 chip 混在选项里，点开只多出**一行** 28px 输入框 + 发送按钮，
    回车即发，发完自动收起；
  - 整块内边距收到 `6px 10px 7px`，问题标题最多两行、备注单行省略，
    弹窗总高通常在 100px 上下，不再遮住对话内容。

## [0.3.1] - 2026-11-15

### 修复

- **主页面档位条不居中、插件页设置也不像卡片——同一个 CSS 选择器错误**：
  根元素自己同时带 `data-dsh-improve-think` 属性和 `dit-band` / `dit-choice` / `dit-page`
  等类名，而样式写成了 `[data-dsh-improve-think] .dit-band`（后代选择器），规则根本命中不到
  这条根元素。于是 `.dit-band` 的 `width` 公式与 `justify-content:center` 从未生效
  （内容按 flex 默认左对齐），设置页的卡片/标题/输入框规则也一并失效。
  现已全部改为复合选择器 `[data-dsh-improve-think].dit-band`，并加测试守住这个坑。
- 顺带把控件尺寸对齐原生工具行：分段轨道 28px、内部按钮 24px、开关 chip 28px、
  字号 13px/20px，行距与原生 chip 一致。

## [0.3.0] - 2026-11-15

### 新增

- **决策选项框（按思考档分级）**：模型可以用新工具 `dsh_choice` 把「接下来往哪个方向做」
  变成一个选项框交给用户点选。
  - 常规档：不启用，调用会被拒绝（保持原有行为）。
  - 严格档：只在**极其重要的决策**（架构、接口、数据结构、删改范围、方案取舍）时弹框。
  - 极致档：几乎只要会改变设计与实现方向的决定都弹框。
  - 每个选项框都带「其它」：点开是空白输入框，**发送按钮始终在**。发送空白内容 =
    「我不知道怎么做，但不满意现在的方案」——模型必须放弃当前方向、重新给出新的选项，
    且不得重复上一批。
  - 选项框不阻塞：模型登记问题后结束本轮，用户在输入框上方直接点选；选完（或取消、
    或提交「其它」说明）后才把决定回传给模型继续。
- 界面：选项框与档位条同宽、同位置（输入框上方），可点 `×` 关闭；回答后投影清空、
  面板自动消失。
- 命令：`/improve choose <编号>`、`/improve choose other <说明>`、`/improve choose cancel`；
  `/improve status` 第 4 行显示当前待选择项。

### 修复

- 档位条**真正居中**：`conversation.input.dock` 的容器比输入卡片宽（左右各让出
  `--dsh-composer-side-clearance`），只写 `width:100%` 会被撑满整条栈而视觉偏左。
  现按原生 QueueDock 的公式扣掉两侧留白与 dock inset，并 `margin:0 auto`。
- `capabilities.ready` 的 TDZ 崩溃：依赖全部就绪时 `reportCapabilities` 可能在 apply 返回前
  执行，原先声明在函数尾部的 `let capabilitiesReported` 会命中暂时性死区，已上移。

## [0.2.7] - 2026-11-14

### 变更

- **选中态换了配色**：不再用"实心主色 + 白字"（主色在部分主题下很浅，白字会糊成一片，
  看不清按钮里写的是什么）。改为**主色淡染底 + 主色内描边 + `label-primary` 文字**，
  强调靠底色与描边承担、文字始终用保证可读的 token；`color-mix` 不可用时退回等价的半透明蓝。
- 主页面档位条整行**居中**（原来靠左），与输入框上沿的其他原生元素对齐。

## [0.2.6] - 2026-11-14

### 修复

- **样式表其实从未注入**（选中态看不出、三个档位一样灰的根因）：本包走 client-modules 的
  `window.__ModuleLoader__` 通道，`ctx.styles` 只存在于"动态双半包"的沙箱上下文里，在这条通道上
  读它就是抛错——之前被 `safeCall` 吞掉后一直退回内联兜底，CSS 里那套「选中 = 实心主色」根本没生效。
  现在改为在 factory 内直接建 `<style>`：宿主会在 factory 执行期间认领这个新标签（打上
  `data-plugin=<包名>`），插件卸载时自动移除，不需要 `ctx.styles`。
- 极端情况下（样式表被 CSP 拦掉）仍给选中项一个内联实心底色，保证"一定能看出选了哪个"。
- **自检结果只能刷新页面才消失**：再点一次「自检」即可收起，结果行右侧也加了显式的 `×`。

## [0.2.5] - 2026-11-14

### 修复

- **主题色落到硬编码兜底**：本版本客户端只有 14 个 `--dsw-alias-*` 主题变量，之前 CSS 里用的
  `surface-*` / `interactive-bg-hover` / `label-tertiary` / `border-l4` / `state-business-primary`
  等名字都不存在，等于一直在用写死的颜色。现在全部换成真实存在的 token，浅色与深色主题各自正确。
- **档位条偶发「一个档位都没选中」**：插件页设置快照处于加载中时是空对象，会盖掉投影里的默认值。
  现将快照限定为 `ready` 且非空才采用，否则回落到投影默认值。

### 变更

- 档位条不再画成"带底色的面板"：去掉底色与边框、改为左对齐的普通行（原生 QueueDock 就是这种形态），
  视觉重量只留在分段轨道与选中项上，避免和输入框卡片叠成两层。

## [0.2.4] - 2026-11-14

### 新增

- **档位条上的「自检」按钮**：向 Host 取一次真实状态（`/improve status`），把返回文本铺在
  条内第二行。这是「功能到底有没有生效」最直接的证据——状态由 Host 按当前会话的真实配置算出，
  不是前端猜的。
- 开关按钮直接写出「开 / 关」文字，不再只靠圆点大小或颜色深浅表达状态。

### 修复

- **选中项看不出来**：选中态从「略深的背景 + 亮一点的文字」改成**实心主色 + 反白文字 + 加粗**，
  未选中项保持透明的次级文字；档位与开关共用同一套选中规则。

### 变更

- 档位条：加「思考档」小标题，三个档位收进浅色轨道的分段控件（`dit-track`），与输入框上沿的
  QueueDock 视觉对齐；间距、行高按 28px 控件规格重排。
- 插件页设置：从一长条平铺改成**卡片分组**（标题 / 说明 / 控件），档位与守护动作也用分段控件，
  五个数值字段收进自适应网格。

## [0.2.3] - 2026-11-14

### 修复

- **主页面档位条点击报 `cannot get property "remote.commands" without inject`**：Client 半的
  `inject` 里只声明了 `sessions`，没声明远程命名空间。宿主把每个远程命名空间注册成独立服务
  （`remote.commands`），**读取属性这一瞬**就会抛错，`try/catch` 包不住。现在 `inject` 补上
  `'remote'` 与 `'remote.commands'`，并把 `runCommand` 改成惰性通道探测：优先
  `remote.commands.execute`（能拿到 `kind/text`），失败再退回 `ISession.command`。
- **插件页改了设置、主页面档位条不跟着变**：会话状态原先整份保存生效配置，插件页的新默认值
  对老会话永远无效。现在状态文件只存**会话覆盖**（`overrides`），未覆盖字段实时跟随插件页；
  投影新增 `defaults` / `overrides` / `overrideKeys`，档位条据此合并，并在有覆盖时显示 `⟲`。
  旧状态文件在加载时自动迁移（只把与默认值不同的字段折算成覆盖）。
- **插件页“改一个开关就把整份默认配置写进会话覆盖”**：新增 `pickPublicOverrides`，只挑显式
  传入的字段，不再用会补全默认值的 `pickPublicConfig`。

### 变更

- 档位条从 `conversation.composer.dock`（卡片**下方**居中的灰色小 pill 行）迁到
  `conversation.input.dock`（卡片**上方**全宽一行，原生 QueueDock 的位置），符合"输入框上方
  一条轻量档位条"的原始需求。
- 样式改走 `ctx.styles.insert()` 注入（作用域 `[data-dsh-improve-think]`、类名前缀 `dit-`），
  尺寸与配色照抄原生 pill / 设置页规格，hover / focus-visible / 深色模式才有处可写。
- 设置面板改用与原生设置页一致的排版（13px 标签、32px 输入框、12px 圆角、自适应网格），
  并支持插件列表里的 `view:'summary'` 摘要态。

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
