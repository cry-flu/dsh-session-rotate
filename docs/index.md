---
title: dsh-session-rotate
---

# dsh-session-rotate

DSH 插件：会话步数到上限时，**在这一轮答完之后**（绝不中途打断）自动开一个新会话、把一份本地拼装的交接摘要投过去、归档旧会话，然后把界面切到新会话。

摘要不调用模型，是纯本地拼装 —— 省下的是「手动总结 + 复制 + 新建会话 + 记住进度」这四步。

[![test](https://github.com/cry-flu/dsh-session-rotate/actions/workflows/test.yml/badge.svg)](https://github.com/cry-flu/dsh-session-rotate/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/cry-flu/dsh-session-rotate?label=release&color=blue)](https://github.com/cry-flu/dsh-session-rotate/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/cry-flu/dsh-session-rotate/blob/main/LICENSE)

## 它解决什么

长会话越滚越贵：上下文越来越长，每一轮都在为全部历史付费。手动换会话又要你先读一遍、写一份摘要、再把摘要贴进新会话 —— 全是机械动作。

这个插件把这几步自动化，并且保证**只在轮末动作**，不会把你正在等的那句话截断。

## 机制

1. `turn/end` 时读取当前步数，和上限比较；
2. 判定该换 → 生成交接摘要（本地拼装，含目标、已完成、待办、文件路径），开新会话并把摘要作为首条消息投进去；
3. 归档旧会话，界面切到新会话。

预判用「近 3 轮步数增量均值 + 1」，避免这一轮跑到越限才换。

## 安装

1. profile 的 `package.json` 里登记依赖和 bundle：

```json
{
  "dependencies": { "dsh-session-rotate": "github:cry-flu/dsh-session-rotate" },
  "dsh": { "profile": { "bundles": ["...", "dsh-session-rotate"] } }
}
```

2. 让 `node_modules` 里有这个名字（装依赖，或手工建链接）：

```powershell
cmd /c mklink /J "<profile>\node_modules\dsh-session-rotate" "<插件目录绝对路径>"
```

3. profile 的 `cordis.patch.yml` 末尾挂载并配置：

```yaml
- insert:
    - id: dsh-session-rotate
      name: dsh-session-rotate
      config:
        defaultMaxSteps: 40
        workspaces:
          - name: my-workspace      # 与侧边栏显示名完全一致
            maxSteps: null          # null / 省略 / 0 / 空串 = 跟随 defaultMaxSteps
```

`workspaces` 默认为空数组 —— 空 = 所有工作区都不生效，用哪个就显式加哪一行。

4. 整个 DSH 换进程重启一次。「重开窗口」不会重载插件。

## 配置项（摘要）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultMaxSteps` | 40 | 全局步数上限 |
| `workspaces[].maxSteps` | 跟随默认 | 单工作区覆盖，`null`/`0`/空串 = 跟随 |
| `minSteps` | 10 | 低于这个步数不换（0 = 关闭这道闸） |
| `cooldownMinutes` | 10 | 两次自动换会话之间的冷却 |
| `maxRotations` | 3 | 冷却窗口内最多换几次，超过即暂停该工作区 |
| `dryRun` | false | 只记录判定结果，不真换 |

完整说明、试运行测法、关闭与卸载、已知限制见 [README](https://github.com/cry-flu/dsh-session-rotate#readme)。

## 链接

- [README（完整文档）](https://github.com/cry-flu/dsh-session-rotate#readme)
- [Releases](https://github.com/cry-flu/dsh-session-rotate/releases)
- [CHANGELOG](https://github.com/cry-flu/dsh-session-rotate/blob/main/CHANGELOG.md)
- [Issues](https://github.com/cry-flu/dsh-session-rotate/issues)

## License

MIT
