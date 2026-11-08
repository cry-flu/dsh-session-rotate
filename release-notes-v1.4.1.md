修复 1.4.0 里设置页一个开关的显示条件。

- 「归档到点时自动跳到新会话」原先只判 `autoSwitch`：把「归档前先留」填 `0` 时，这一行照样出现，勾上也照旧无效（此时 `archivePlan` 返回 `'none'`，根本不会建延迟归档）。
- 现在改为 `autoSwitch || !(deferArchive > 0)` 才不渲染（`lib/client.js:470`、`lib/client.js:482`），界面、文案、服务端判定三者一致。

1.4.0 没有单独发过版（没打过 tag），这是第一个带此修复的发布。

**本次重打包补入**（运行时代码无改动）：重录的 6 镜头演示 GIF，以及 README 一条使用提醒 —— 延迟归档的保留期内不要在旧会话里继续发消息：顺延只在轮与轮之间重算，跑得比剩余保留期长的那一轮会被 `stopActivity` 的归档中途掐掉并归档，任务做一半就断。

完整变更见 [CHANGELOG.md](https://github.com/cry-flu/dsh-session-rotate/blob/main/CHANGELOG.md)。

**安装**

```powershell
dsh plugin add github:cry-flu/dsh-session-rotate
```

它只做登记（写 profile 的 `package.json` 依赖与 bundle 名单）。这个包的 bundle patch 是**刻意留空**的（挂载条目要带 `workspaces` 配置，只能写在 profile 里），所以还得在 profile 的 `cordis.patch.yml` 末尾 insert 一条 `dsh-session-rotate`，否则设置页里不会出现「会话换新」。四步完整步骤见 [README 的安装一节](https://github.com/cry-flu/dsh-session-rotate/blob/main/README.md#安装)：关键是第 3 步的 `workspaces` 填你在用的工作区名，第 4 步**整个 DSH 换进程重启**（重开窗口不算）。
