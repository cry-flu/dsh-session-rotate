# Changelog

本项目的所有重要改动都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.1.0] — 2026-11-08

换新后不必回旧会话翻最后一条回复。

### 变更

- 交接摘要末尾改为附上「上一会话最后的回复」**全文**（≤4000 字，超出头尾各留一段）：以前只取最后 200 字压成一行，常常是半句开头，读不懂。
- 新增 `archiveOnRotate`（默认 `true`）：设 `false` 后换新不再归档旧会话，旧会话留在列表里方便回看。设置页对应勾选「换新时归档旧会话」。
- 交接摘要的「步数」行写明旧会话是否已归档，不再一律写「已归档」。

### 文档

- 新增 `CONTRIBUTING.md` 与 PR 模板：本地开发、测试、提交信息格式、不会被接受的改动
- `README.md` / `README.en.md` 安装章节标注：npm 上的同名包 `dsh-session-rotate` 与本项目无关
- README（中英）与 Pages 站点补 `archiveOnRotate` 与新的交接摘要格式

## [1.0.0] — 2026-11-07

首个公开发布版。功能与 0.2.1 完全相同，只做「交给外人用」所需的收拾，不夹带行为变更。

### 变更

- 版本号 `0.2.1` → `1.0.0`；`engines.node` 声明 `>=20`。
- `npm test` 从 `node --test "test/*.test.mjs"` 改为 `node --test`：自动发现测试文件，不依赖 shell 展开 glob，Node 20 / 22 / 24 都能跑。
- `package.json` 补齐 `repository` / `bugs` / `homepage` / `author`；`files` 显式包含 `CHANGELOG.md` 与 `LICENSE`。
- README：删除全部本机绝对路径，安装步骤改为 `github:OWNER/REPO` + 占位路径；补充「改完代码怎么让它真正加载」（`taskkill /T` 换整棵进程树）；补充与两个同名/相似插件的区别表；修掉「19 个用例」与实测 23 个不一致的错误。
- 新增 `.github/workflows/test.yml`：Ubuntu / Windows × Node 20 / 22 / 24 跑单测。
- 删除仓库内的本地调试脚本（探针、重启脚本）与各版本 `.bak` 备份。

### 已知限制

见 README「已知限制」一节，其中最需要注意的是：**上限是软上限**，真实换新点会在 `maxSteps` 附近浮动。

## [0.2.1] — 2026-11-07

### 修复

- `lib/index.js`：新增 `userTexts()`，收集用户指令时排掉「上一轮投递的交接摘要」——它带 `source.kind='user'`，不排会被当成用户指令再抄进下一份摘要，导致「当前目标」永远是交接文本、越换越发散。`HANDOFF_MARK` 常量与模板首行共用，改文案不会漏。
- `lib/index.js`：dry-run 去重集合 `dryLogged` 超过 500 条自动清空，长期开试运行不会无限涨。

### 测试

- 新增 `test/summary.test.mjs`（4 个用例），`npm test` 共 23 个用例。

## [0.2.0] — 2026-11-07

### 新增

- `lib/index.js`：`state.json` —— 冷却记录、连续换新时间戳、暂停名单、每个工作区的增量历史。以前这些全在内存里，**重启就等于绕过所有保护**；现在重启会接着算，`clearPause` 或删文件才是出口。
- `lib/index.js`：`configWarnings()`，POST 保存时若某上限低于生效的 `minSteps`（这道闸永远不生效），响应带 `warnings`，面板直接显示并写进 `debug.log`。
- `lib/client.js`：设置页新增「保护闸与试运行」卡片（最小步数、冷却分钟、连续换新上限、试运行开关），页首注明上限是软上限；保存时把这些键一起提交（以前面板只提交 `defaultMaxSteps` 和名单，缺的键会被回落成默认值）。

### 变更

- 增量历史从「按会话」改为「按工作区」并跨会话保留 → 新会话首轮就有先验，不再出现「40 步上限在 20 步就换」。`decide.js` 里那条 `steps + steps` 保守上界只对「该工作区从没换过」生效。
- 判定顺序改为：暂停 → `decideRotate()` → `dryRun` → 冷却 → 连续换新闸 → 真换。dry-run 排在冷却之前，试运行才能记下「判据已命中、被冷却挡住」的情况；dry-run 期间不累积连续换新计数。
- dry-run 日志按「会话@步数」去重，并附带冷却剩余时间。
- `sanitizeConfig(raw, prev)` 支持从旧配置继承未提交的键，工作区级 `minSteps` / `cooldownMinutes` / `maxRotations` 覆盖项不会被面板保存冲掉。
- `debug.log` 超过 1 MB 自动转存为 `debug.log.1`。
- 摘要模板改文案：「已完成」→「更早的用户指令（只是历史记录，不是待办）」，第二行固定声明「除用户下一条新指令外，不要自行执行」，上限 15 → 16 行。

### 测试

- 新增 `test/`（`decide.test.mjs` + `config.test.mjs`），`npm test` 19 个用例。

## [0.1.1] — 2026-11-07

- 面板空名单需二次确认（宿主拒绝无 `confirmEmpty` 的空 `workspaces`）。
- 判定顺序：暂停 → 冷却 → `decideRotate()` → `dryRun` → 连续换新闸 → 真换。

## [0.1.0] — 2026-11-07

- 初版：按工作区配置 `maxSteps`，越限后在轮末换新会话、投递本地拼装的交接摘要、归档旧会话、前端跳转。
- 设置页可编辑默认步数上限与工作区名单。
