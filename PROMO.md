# 推广材料（不进 Pages，仅仓库内部用）

本文件是发布/推广用的素材草稿：release notes 正文、演示 GIF 的录制与压制步骤、发帖用短文案。
改完这里的内容再手动贴到 GitHub / 社区，不要直接把本文件当文档发出去。

---

## 一、v1.0.0 Release Notes（直接整段贴进 GitHub release 正文）

> 编辑入口：https://github.com/cry-flu/dsh-session-rotate/releases/edit/v1.0.0
> 没有 `gh` CLI，走网页编辑即可；或者装 `gh` 后用 `gh release edit v1.0.0 -F PROMO.md`（只取下面代码块里的部分）。

```markdown
长会话越滚越贵。步数到上限时，这个插件在**这一轮答完之后**（绝不中途打断）自动开新会话、把一份本地拼出来的交接摘要投过去、归档旧会话，再把界面切到新会话。摘要不调用模型，是纯本地模板拼装——省下的是「手动总结 + 复制 + 新建会话 + 记住进度」这四步。

### 它解决什么

- **省钱但不额外花钱**：交接摘要由本地模板生成（取最近用户消息 + 最后一条回复，最多 16 行），零模型调用。真正计费的只有新会话的第一轮请求。
- **不打断**：只在轮与轮之间判定，正在跑的轮一定跑完。上限是**软上限**，换新点会在 `maxSteps` 附近浮动。
- **可先空跑验证**：`dryRun` 只写日志、不建会话、不归档、不跳转。
- **不会连环换**：`minSteps` 硬下限 + `cooldownMinutes` 冷却 + `maxRotations` 连续触发后自动暂停该工作区（状态持久化在 `state.json`，重启不清零）。

### 安装（四步）

1. profile 的 `package.json` 里登记依赖和 bundle：
   ```json
   {
     "dependencies": { "dsh-session-rotate": "github:cry-flu/dsh-session-rotate" },
     "dsh": { "profile": { "bundles": ["...", "dsh-session-rotate"] } }
   }
   ```
2. 让 `node_modules` 里有这个名字（跑包管理器 install，或 `cmd /c mklink /J "<profile>\node_modules\dsh-session-rotate" "<插件目录绝对路径>"`）。
3. 在 profile 的 `cordis.patch.yml` 末尾挂载：
   ```yaml
   - insert:
       - id: dsh-session-rotate
         name: dsh-session-rotate
         config:
           defaultMaxSteps: 40
           workspaces:
             - name: my-workspace      # 与侧边栏显示名完全一致
               maxSteps: null          # null / 省略 / 0 / "" = 跟随 defaultMaxSteps
   ```
   `workspaces` 为空数组 = 所有工作区都不生效，用哪个就加哪一行。
4. **整个 DSH 换进程重启一次**。「重开窗口」不会重载插件；重启后 Web GUI 端口会变。

### 先空跑确认再真用

把要测的工作区加进 `workspaces`（`maxSteps` 填你真实在用的值），打开 `dryRun`，正常干活跨过那个步数，然后看 `~/.dsh/session-rotate/debug.log`：命中会记一条 `[dry-run] 只记日志不换`（同一会话同一档步数只记一次）。

别把 `maxSteps` 调成 2、3 去真测——换新是真的换，一晚上能刷出一屏空会话。

### 已知限制（先说清楚）

- **热重载无效**：改插件代码（尤其 `lib/client.js`）后必须整个 DSH 换进程重启。
- **上限是软上限**：判定只在轮间发生，开预判通常略早，关预判可能明显偏高（一轮能跑掉二十几步）。
- **新会话第一轮照常计费**：摘要本身零成本，但那一轮请求是真的。
- 只对顶层会话生效，子会话跳过；每个会话只触发一次。

### 兼容性

只在我本人环境验证过：DSH 桌面版 `0.2.1-rc.3`（Windows）+ Node `v24.18.0`，`npm test` → 23 pass / 0 fail。CI 在 ubuntu + windows × node 20/22/24 跑单测，但**不覆盖宿主行为**，其他环境请先小范围试用。

### 注意

**不在 npm 上。** 包名 `dsh-session-rotate` 在 npm 上属于另一位作者的同名插件，不是本项目。

大部分代码由 AI 辅助生成，经人工审查与本地测试，但不保证所有环境行为如预期。有问题请开 issue，最想要的是「你的环境里到底能不能正常触发」。
```

---

## 二、演示 GIF：录什么 + 怎么压

### 录什么（30 秒，8 个镜头，别再长）

| 秒 | 画面 | 目的 |
| --- | --- | --- |
| 0–3 | DSH 侧边栏，某个会话的步数已经很高 | 立住"长会话"这个场景 |
| 3–6 | 设置 → 会话换新，`minSteps / cooldown / maxRotations` 一屏 | 证明"有保护闸，不会乱换" |
| 6–9 | 打开 `dryRun` 开关 | 证明"可以先空跑" |
| 9–14 | 正常对话两轮，跨过上一步数 | 真实触发过程 |
| 14–18 | `debug.log` 里 `[dry-run] 只记日志不换` | 空跑命中的证据 |
| 18–21 | 关掉 `dryRun` | 切到真跑 |
| 21–27 | 再跨一次：轮末自动换新会话，界面切过去、旧会话进归档 | 核心卖点 |
| 27–30 | 新会话第一条消息就是交接摘要（滚动露两行） | 证明"进度没丢" |

录制要点：**1280×720 以上、只录窗口区域**、不要录到自己的 key/路径/其他会话标题、别用鼠标画圈（GIF 里会糊）。

### 路线 A：ScreenToGif（GUI，最省事，不用装 ffmpeg）

1. 装 [ScreenToGif](https://www.screentogif.com/)（开源，绿色版可用）。
2. Recorder → 框选窗口 → 15 fps 录制。
3. 录完在编辑器里删掉多余帧（这一步是压体积的关键），另存为 GIF。
4. 目标：**≤ 3 MB**。超了就删帧、或把宽度降到 1000px。

### 路线 B：ffmpeg（先录 mp4，再压成 GIF）

本机目前**没有 ffmpeg**（`where.exe ffmpeg` → 找不到）。要装的话：

```powershell
winget install --id Gyan.FFmpeg -e
# 装完重开一个终端，ffmpeg -version 能出版本号再继续
```

录 mp4（任选其一：`Win+G` Xbox Game Bar，或 OBS 只录窗口），存成 `demo.mp4`，然后两遍调色板压制（第二遍才出高质量小体积 GIF）：

```powershell
cd 'D:\dsh-plugins\dsh-session-rotate'
ffmpeg -y -i demo.mp4 -vf "fps=12,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
ffmpeg -y -i demo.mp4 -i palette.png -lavfi "fps=12,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 docs\img\demo.gif
(Get-Item docs\img\demo.gif).Length / 1MB
```

体积超 3 MB 就按顺序调：`fps=12 → 10 → 8`，`scale=1000 → 900 → 800`，或者直接把 mp4 剪短。压制完删掉 `palette.png` 和 `demo.mp4`（别提交进仓库，仓库里只放 GIF）。

### 压完把 GIF 插进两份 README

中文 `README.md` 的 `## 功能` 之前插一行：

```markdown
![步数到上限后自动换新会话，交接摘要随新会话带过去](docs/img/demo.gif)
```

英文 `README.en.md` 的 `## Features` 之前插同一行（路径相同）。

插完各跑一次检查：`git status --short` 应看到 `docs/img/demo.gif` 是新增，两份 README 是修改。

---

## 三、发帖短文案（一次一句，别改写成长文）

**群里转发（一句 + 链接）**

> 分享个自己写的 DSH 插件：会话步数到上限自动换新会话，交接摘要本地拼、不调模型。只在轮末换、不打断，有 dryRun 可以先空跑验证。装的时候注意要**整个 DSH 换进程重启**（重开窗口不算）。https://github.com/cry-flu/dsh-session-rotate

**X / 推**

> Built a plugin for DeepSeek Harness: when a session hits its step limit, it rotates at the turn boundary, hands over a locally-templated summary (zero model calls), archives the old session and switches the UI. Dry-run mode first. MIT. https://github.com/cry-flu/dsh-session-rotate

**V2EX 标题候选**

- `做了个 DSH 插件：长会话到上限自动换新，交接摘要不花 token`
- `长会话越聊越贵，我写了个插件在轮末自动换新会话`

**正文骨架（正文只说这六段，别加第七段）**

1. 痛点：一个会话滚到几十步，每轮都在为历史付费（讲自己的账，不编数字）。
2. 解法：轮末换新 + 本地拼摘要 + 保护闸防连环换。
3. 怎么装：四步，**标注"必须换进程重启"**。
4. 怎么先验证：`dryRun` 步骤，四行。
5. 已知限制：软上限、只对顶层会话生效、只在自己环境测过。
6. 求什么：**求 issue，不求 star** —— 最想知道"你环境里能不能正常触发"。
