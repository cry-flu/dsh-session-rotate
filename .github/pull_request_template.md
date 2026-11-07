## 改了什么

<!-- 一句话说清这个 PR 做了什么。多个不相干的改动请拆成多个 PR。 -->

## 为什么

<!-- 关联 issue：Fixes #123。没有 issue 就说明触发场景：什么配置、什么步数、看到的什么现象。 -->

## 怎么验证的

- [ ] `npm test` 全绿（node 20 / 22 / 24）
- [ ] 在真实 DSH 里手动验过：

<!-- 贴 debug.log 里相关的几行，注意抹掉个人路径和 session UUID -->

## 影响面

- [ ] 不改变默认行为（未配置的工作区仍按 `defaultMaxSteps` 走）
- [ ] 动了 `lib/client.js` → 已整个 app 换 PID 重启，确认设置页生效
- [ ] 动了判定逻辑 → 已覆盖 paused / 冷却 / `minSteps` / `maxRotations` 的既有分支
- [ ] 已更新 `CHANGELOG.md` 的 `[Unreleased]`

## 其他

<!-- 截图、GIF、取舍说明。新增运行时依赖需要先开 issue 讨论。 -->
