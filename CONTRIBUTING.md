# 参与贡献

欢迎提 issue / PR。这个项目很小，规则也简单。

## 开发环境

- Node.js `^22.19.0 || >=24.0.0`（CI 覆盖 22、24）
- 运行中的 DeepSeek Harness（可选，只有需要真机验证时才用）

```bash
npm run check      # 只做语法检查
npm test           # 单元测试：core 状态机 + client 渲染（不需要浏览器）
npm run selftest   # 10 条验收场景：用假 Cordis ctx 驱动真实插件代码
```

三套测试都不需要网络、不需要启动 DSH、不需要模型。

## 改代码前请先读

- `docs/DESIGN.md`：定位、边界、为什么这样实现
- `docs/EXTENSION-POINTS.md`：用到哪些 DSH 扩展点、缺失时怎么降级

## 硬性边界（改代码时不要突破）

1. **不改 `reasoning_effort`**，也不因为切档位降低推理强度。
2. **不以"推理时间长"为理由打断**：只有可检测的"重复且无进展"信号才允许干预。
3. **不确定时默认放行**：宁可漏拦，不要误伤正常推理。
4. **不静默降级**：能力缺失必须写日志并在 UI / `status` 里体现。
5. 新增/修改设置项时，同步三处：`Config` schema（含中文 `.description()`）、`lib/core/config.js` 的 `DEFAULTS`、
   `lib/client.js` 的 `settings.*` 文案（zh + en）。

## 提交前

```bash
npm run check && npm test && npm run selftest
```

如果是行为改动，请在 `CHANGELOG.md` 的 `Unreleased` 下加一条；如果改了扩展点适配，同步更新
`docs/EXTENSION-POINTS.md`。

## 提交信息

用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀，一句话说清"改了什么、为什么"。
