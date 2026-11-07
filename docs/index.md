---
title: dsh-session-rotate
---

# dsh-session-rotate

[![test](https://github.com/cry-flu/dsh-session-rotate/actions/workflows/test.yml/badge.svg)](https://github.com/cry-flu/dsh-session-rotate/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/cry-flu/dsh-session-rotate?label=release&color=blue)](https://github.com/cry-flu/dsh-session-rotate/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![文档](https://img.shields.io/badge/docs-GitHub%20Pages-blue.svg)](https://cry-flu.github.io/dsh-session-rotate/)

长会话越滚越贵。步数到上限时，本插件在**这一轮答完之后**（绝不中途打断）自动开一个新会话、把一份本地拼出来的交接摘要投过去、归档旧会话，然后把界面切到新会话。摘要不调用模型，是纯本地拼装，省下的是「手动总结 + 复制 + 新建会话 + 记住进度」这四步。

- 运行环境：DeepSeek Harness（DSH）桌面版 / Web GUI，作为 profile 插件挂载
- 不在 npm 上（`dsh-session-rotate` 这个包名已被另一位作者的同名插件占用，**不是本项目**）

## 功能

| 能力 | 说明 |
| --- | --- |
| 按工作区单独设上限 | 每个工作区一条 `maxSteps`；留空则跟随全局默认，且跟着默认一起变 |
| 模板拼接交接摘要 | 固定模板：头部 ≤16 行（最近用户消息 + 历史指令），后面**原样附上上一轮助手回复全文**（≤4000 字，超出头尾各留一段）。**不额外调用模型** |
| 轮次预判 | 用最近 3 轮增量的均值估下一轮，在轮边界提前换，而不是等越限才换 |
| 保护闸 | `minSteps` 硬下限、`cooldownMinutes` 冷却、`maxRotations` 连续触发后暂停该工作区 |
| 试运行 | `dryRun` 只写日志，不建会话、不归档、不跳转 |
| 控制界面 | 设置页「会话换新」里改默认上限、保护闸、试运行开关，保存即生效 |

## 安装

**1. profile 的 `package.json`：登记依赖和 bundle**（已 clone 到本地可用 `"link:<插件目录绝对路径>"` 或 `"file:<同上>"` 代替 `github:`）

```json
{
  "dependencies": { "dsh-session-rotate": "github:cry-flu/dsh-session-rotate" },
  "dsh": { "profile": { "bundles": ["...", "dsh-session-rotate"] } }
}
```

**2. 让 `node_modules` 里有这个名字** —— 在 profile 目录跑包管理器 install；手工建链接也行：

```powershell
cmd /c mklink /J "<profile>\node_modules\dsh-session-rotate" "<插件目录绝对路径>"
```

**3. profile 的 `cordis.patch.yml` 末尾挂载并配置**

```yaml
- insert:
    - id: dsh-session-rotate
      name: dsh-session-rotate
      config:
        defaultMaxSteps: 40
        workspaces:
          - name: my-workspace      # 与侧边栏显示名完全一致（空格、大小写都算）
            maxSteps: null          # null / 省略 / 0 / 空串 = 跟随 defaultMaxSteps
```

`workspaces` 默认为空数组 —— **空 = 所有工作区都不生效**，用哪个工作区就显式加哪一行。

**4. 整个 DSH 换进程重启一次。**「重开窗口」不会重载插件；重启后 Web GUI 端口会变，看启动日志里的新地址。

## 配置

配置文件 `~/.dsh/session-rotate/config.json`，设置页改的是同一份数据，保存即生效：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultMaxSteps` | `40` | 默认步数上限 |
| `workspaces[]` | `[]` | `{ name, maxSteps }`；不在名单里的工作区不生效 |
| `minSteps` | `10` | 累计步数不到这个数就不换；`0` = 关掉这道闸 |
| `cooldownMinutes` | `10` | 同一工作区在该时间窗内最多换 1 次 |
| `maxRotations` | `3` | 在 `cooldown × maxRotations` 窗口里换满即暂停该工作区（状态存 `state.json`，重启不清零） |
| `dryRun` | `false` | 试运行开关 |
| `archiveOnRotate` | `true` | 换新时归档旧会话；设 `false` 则旧会话留在列表里（上一轮正文仍会整段贴进交接摘要） |

`maxSteps` 留空 = 跟随默认，之后改默认值它跟着变；填正整数就固定成那个数。工作区名必须与侧边栏显示名**完全一致**，对不上会静默跳过，实际匹配情况看 `debug.log`。

## 用试运行测（dryRun）

想确认「到点会不会触发」，用它，不要靠改上限去真测：

1. 在 `workspaces` 里加上要测的工作区，`maxSteps` 填**你真实在用的值**（例如 40）；
2. 打开 `dryRun`（设置页开关，保存即生效，无需重启）；
3. 正常干活，跨过那个步数；
4. 看 `~/.dsh/session-rotate/debug.log`：命中会记一条 `[dry-run] 只记日志不换`（同一会话同一档步数只记一次，不会刷屏）。

**不要**把 `maxSteps` 调成 2、3 去真测：换新是真的换（新建会话、归档旧会话、界面跳走），一晚上能刷出一屏空会话。测完把 `dryRun` 关掉。

## 关闭与卸载

临时关闭：`workspaces` 改成 `[]`（或删掉配置），保存即生效。

彻底卸载：删掉 `cordis.patch.yml` 里那段 `- insert:`；从 profile 的 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 各删一行；删掉 `node_modules/dsh-session-rotate` 链接；重启 DSH。

```bash
rm -rf ~/.dsh/session-rotate      # 可选：连日志、暂停状态、增量历史一起删
```

## 已知限制

- **热重载无效。** 改插件代码（尤其 `lib/client.js`）后必须整个 DSH 换进程重启，「重开窗口」不算；重启后 Web GUI 端口会变。
- **上限是软上限。** 判定只发生在轮与轮之间，不打断进行中的轮，真实换新点会在 `maxSteps` 附近浮动：开预判通常略低，关预判往往明显偏高（一轮能跑掉二十几步）。
- **换新后的第一轮是一次真实请求。** 新会话把交接摘要作为第一条用户消息发出去，摘要本身零成本，但那一轮对话照常计费，会产生少量 token 费用。
- 只对顶层会话生效，子会话跳过；每个会话只触发一次；被暂停的工作区用 `POST /dsh-session-rotate/config` 带 `{"clearPause": true}` 恢复，或删 `~/.dsh/session-rotate/state.json` 后重启插件。

## 测试情况

只在我本人环境跑过，**没有**跨平台、跨版本验证：DSH 桌面版 `0.2.1-rc.3`（Windows）+ Node `v24.18.0`，`npm test` → 23 pass / 0 fail（`node --test`）。CI（`.github/workflows/test.yml`）会在 ubuntu + windows × node 20/22/24 上跑单测，但那只覆盖单测，不覆盖宿主行为。

## 声明

大部分代码由 AI 辅助生成，经人工审查与本地测试，但**不保证**在所有环境下行为如预期。请先小范围试用、确认没有副作用，再拿它处理重要会话。

## 控制界面

![设置 → 会话换新：默认步数上限、工作区名单、保护闸与试运行](img/session-rotate-settings.png)

设置 → 会话换新。上半是**默认步数上限**（只对「已勾选、但步数栏留空」的工作区生效）；中间是**工作区名单**，勾选启用，步数栏填数字就用它自己的上限、留空则跟随默认；下半是**保护闸与试运行**：截图里只到「最小步数」和「冷却（分钟）」，再往下还有最多轮换次数、「试运行（只记日志不换）」开关，以及「换新时归档旧会话」开关。

## License

[MIT](LICENSE)
