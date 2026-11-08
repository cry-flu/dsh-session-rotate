# NOTES — dsh-session-rotate 工作笔记

> 长期有效的作者规矩集中在本文件第 1 节。每个会话开工前先读这一节，再动手。
> 与 `CONTRIBUTING.md` 的「发版与版本号（硬规矩）」是同一份内容，两边改动要同步。

## 0. 现状一句话

插件已发布到 `https://github.com/cry-flu/dsh-session-rotate`，当前正式版 `v1.4.1`。本地 `main` 已提交、**未 push**（本地提交不影响对外，push 需要维护者说「执行」）。

## 1. 发版与版本号（硬规矩）

> 这套规矩由维护者确定，长期有效。**任何一条拿不准，先停下来问，不要凭习惯动作。**

### 1.1 谁决定

任何 **push、打 tag、创建 GitHub Release、发布到 npm**（或任何对外渠道）都必须维护者明确回复「执行」才能做。没说「执行」之前，只准在本地提交（`git commit`），不准对外发布 —— 包括 `git push`、`git push --tags`、`npm publish`、`POST /releases`。

### 1.2 发版前先给维护者看三样

1. 本次改动文件清单
2. `CHANGELOG.md` 草稿
3. 建议的版本号 + 理由

确认后才发。

### 1.3 版本号（SemVer）

| 改动性质 | 版本号 |
|---|---|
| 只修 bug，不改行为 | 补丁号：`1.4.1 → 1.4.2` |
| 新增功能，不影响旧用户 | 次版本：`1.4.x → 1.5.0` |
| 改默认值 / 删改配置项 / 改变已有行为 | **破坏性变更**：CHANGELOG 的「默认行为变更」用表格写清旧值→新值，**先问是否升主版本**，不要自己定 |

- 不要一次跳多个版本号。
- 不要为一个小改动单独发版。

### 1.4 发版节奏

- 同一天最多发 1 个版本；两次发版之间至少隔 24 小时。
- 例外只有紧急的数据损坏或安全问题，且必须先问。
- 平时多个小改动先攒在本地，攒一批再合成一个版本。
- 想试验的用预发布号（`1.5.0-beta.1`），Release 勾「预发布」，不要直接发正式版。

### 1.5 功能冻结

没有明确要求，**不新增功能、不新增配置开关**。开关越多用户越容易配错；发现新需求先报告，由维护者决定。

### 1.6 不改已发布的版本

已发出的 tag 与 Release **不删除、不移动、不重写历史**。有问题就发新的补丁版本。

例外只在维护者明确说「就改这个版本」时开一次（2026-11-08 重打包 `v1.4.1` 即此情形，原话：「直接改吧，目前0个人除了我在用这个插件」）。改之前把代价写清（谁会被影响、版本号不变意味着什么），改完把新旧 commit / tag object / 附件 digest 一起列出来对账。

### 1.7 发版后要列清单

每次发版后，把「已发布的版本、tag、Release 链接」列出来给维护者核对。

### 1.8 版本号冲突

npm 上已有同名包（或版本号被占用）时，**不要自己改名发布**，先问。

## 2. 本机工作环境（排查用）

- 代码目录：`D:\dsh-plugins\dsh-session-rotate`
- 配置：`~/.dsh/session-rotate/config.json`（每次判定现读，保存即生效）
- 状态：`~/.dsh/session-rotate/state.json`（`ownSessions` / `deferredArchives` / `paused`）
- 日志：`~/.dsh/session-rotate/debug.log` —— 版本号与判定分支的**唯一**可信证据
- `lib/index.js`、`lib/client.js` 改完必须整个 app 换 PID 重启才加载；纯函数（`lib/decide.js`、`summaryText`）有单测，`npm test` 即可
- 实测数据复算：`pwsh -File tools\usage-summary.ps1 -Path <usage_data_*.zip 或解压目录>`

## 3. 未提交 / 未发布的留痕

**`v1.4.1` 已重打包上线（2026-11-08 12:24），工作树干净、main 与 origin/main 齐平。**

- main `d2dcaf1`，收进三个提交：`d2dcaf1` README 提醒、`4472e8f` 发版规矩文档、`3d3d29e` GIF 重录
- tag `v1.4.1` 由 `a628022`（指向 `2330bfc`）强移到 `d2dcaf1`；远端 annotated tag object 现为 `5e51865`
- Release `v1.4.1`（id 437983166）正文已换成带「本次重打包补入」的版本；附件换新：`dsh-session-rotate-1.4.1.tgz` 45819 B，`sha256:6fcd34fe3a2812d8010a01a88ac588bd4062fed2556022ec6a81b24644578684`（旧附件 40411 B 已删）
- 本机出网踩坑：`C:\Windows\System32\drivers\etc\hosts:30` 早先被钉成 `20.27.177.113 github.com`，该 IP 443 超时（`api.github.com`/`codeload`/`ssh` 反而通），git push 报 `Connection was reset`。改成 `140.82.113.3 github.com` 后直连恢复 200；原文件备份在 `hosts.bak-20261108`
- 包内容确认：`files` 字段只收 `lib/ cordis.patch.yml README.md README.en.md CHANGELOG.md LICENSE`，**tgz 里从来没有 `docs/`**，所以「Release 附件与仓库 GIF 不一致」这个说法不成立 —— 图只存在于仓库与 GitHub Pages
- 待办：真换新三场景实测（要改真 HOME 的 `config.json`，跑起来会真换会话，需维护者点头）
