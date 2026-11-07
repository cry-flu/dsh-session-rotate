# 参与贡献

这个插件做的事情很小：在会话步数到上限时，于轮末开一个新会话、把本地拼装的交接摘要投递过去、归档旧会话。改动它之前，建议先读一遍 README 的「触发时机与范围」——**上限是软上限**，真实换新步数在 `maxSteps` 附近浮动是设计如此。

## 环境

- Node ≥ 20（见 `package.json` 的 `engines`）；CI 在 20 / 22 / 24 × ubuntu / windows 上跑
- 零运行时依赖：新增 `dependencies` 前请先开 issue 讨论，别直接提 PR

## 本地开发

在 profile 的 `package.json` 里把依赖指到本地目录，改完重启宿主即可：

```json
"dependencies": { "dsh-session-rotate": "link:D:\\path\\to\\dsh-session-rotate" }
```

## 跑测试

```powershell
npm test        # node --test，纯函数单测，不碰宿主
```

`test/` 下三个文件分别覆盖配置归一化（`config.test.mjs`）、换新判定（`decide.test.mjs`）、摘要拼装（`summary.test.mjs`）。改这三块逻辑请同步补用例。

## 代码在哪

| 文件 | 职责 | 注意 |
|---|---|---|
| `lib/index.js` | 插件主体：钩子注册、旋转流程、摘要投递 | 主进程代码，改完必须整个 app 换 PID 重启才加载 |
| `lib/decide.js` | 纯函数判定：是否该换、预估本轮步数 | 有单测，判定逻辑优先在这里改 |
| `lib/client.js` | 设置页前端：卡片、保存、快照读回 | 也是主进程注入的，同样要换 PID；排查看 `debug.log` 的「已加载 v…」行 |

排查手段永远是 `~/.dsh/session-rotate/debug.log`：判定、冷却、`minSteps`、连续触发闸、dry-run 每个分支都会在那里留痕。

## 提交信息

`type(scope): 一句话`，例如：

```
fix(decide): 冷却窗口内不再重复触发
docs(promo): 路线 A 换成仓库自带录制脚本
```

type 用 `feat` / `fix` / `docs` / `test` / `chore`，scope 用模块名（`index` / `decide` / `client` / `docs`）。一个提交只做一件事。

## 提 PR 之前

1. `npm test` 全绿
2. 行为有变就更新 `CHANGELOG.md` 的 `[Unreleased]`
3. 涉及设置页或判定逻辑的改动，附上重启后实测的 `debug.log` 片段（**请抹掉个人路径与 session UUID**）
4. 面向用户的行为变化，`README.md` 与 `README.en.md` 一起改

## 不会被接受的改动

- 把软上限说成硬上限，或改文案暗示「精确在第 N 步换新」
- 为了现有零依赖就能做到的事引入运行时依赖
- 只改注释 / 排版，却和功能改动混在同一个 PR 里
- 未经讨论就改默认行为（未配置工作区时的 `defaultMaxSteps`）

## 安全问题

发现可导致任意代码执行、路径穿越、或把本地敏感内容（路径、session UUID、对话正文）写进摘要/日志的问题，请先私下联系仓库作者，不要直接开公开 issue。
