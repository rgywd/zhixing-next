# 知行 Next 协作入口

本仓库包含新的 React Native 客户端与轻量 Python 后端，架构独立于其他知行子仓。上层工作区规则仍适用。

## 产品工作原则

- 知行替用户整理信息。聊天、截图、文件和直接操作都应能自然进入同一服务；不要为了数据整齐要求用户找原话、逐项对账、反复确认或管理内部状态。
- 先让一个真实场景用起来，再增加结构和自动化。只有影响实际行动的歧义才追问；不清楚的金额、能力或结果不得编造。
- 来源、版本和回执可在后台支持纠错与恢复，但不默认成为记忆、财务或日常聊天的操作门槛。产品语义见 [PRODUCT.md](docs/PRODUCT.md) 和 [MEMORY.md](docs/MEMORY.md)。

## 入口与边界

- 先读 [README.md](README.md) 和 [文档入口](docs/README.md)。
- 客户端视觉修改遵循 [共享 UI](docs/UI.md)，优先复用 `src/theme.ts` 的尺度与 `src/ui.tsx` 的组件，页面只保留专有布局。
- 后端实现、启动与已验证边界见 [backend/README.md](backend/README.md)，接口由 [docs/API.md](docs/API.md) 维护。
- [架构讨论稿](docs/ARCHITECTURE.md) 区分用户已确认方向与待讨论建议；建议不能当作已实现能力。
- 不自动移植旧仓的模块、协议、数据格式或部署配置；复用需有当前需求和代码证据。
- 第一阶段聚焦服务器执行，后端优先 Deep Agents / LangGraph；App 虚拟执行环境及外部 harness 编排后续扩展。
- 按需增加模块，不为后续扩展建立空实现、通用适配器、调度平台或用户看得见的管理流程。
- 从 `main` 切短分支；存在其他任务或脏改动时使用干净 worktree。
- 不提交凭据、依赖目录或构建产物，不把服务端模型密钥放进 App。

## Git 工作流

- `main` 保持可构建、可测试；日常改动通过短分支 PR 合入。禁止直接推送、强推或删除 `main`。
- 分支命名与知行主仓一致：`feat/需求号-英文简述`、`fix/问题号-英文简述`、`chore/英文简述`、`exp/英文简述`；简述使用小写 `kebab-case`，分支名只包含一层 `/`。
- Commit header 使用英文 Conventional Commit 类型与可选 scope，中文摘要；正文用 `1.`、`2.` 编号说明改动与验证。
- 推送或创建 PR 前，在最终提交上完成下方适用的本地验证；PR 的 `PR policy` 检查分支名。存在并行任务时从干净的 `main` 创建独立 worktree，不带入其他工作树的未提交改动。
- 只有用户明确要求正式发布时，才创建 `release/x.y.z`、正式标签或 GitHub Release。提交、推送与 PR 合并均不等于发布。

## Expo 与原生代码

- 以 `package.json` 为版本依据；修改 Expo API 前查对应 SDK 版本的官方文档。
- 通过 `npx expo install <package>` 选择兼容依赖，使用 npm 并提交 lockfile。
- `android/`、`ios/` 由 Expo 生成；原生配置放入 `app.json` 或 config plugin。
- Expo Go 用于基础调试；需要额外原生能力时使用 development build。
- 构建工具和发布服务分开选择；不因使用 Expo 自动配置云服务或发布。

## 验证

交付前执行 `npm run typecheck`、`npm run lint` 与 `npm run test:mobile`。客户端源码、依赖或构建配置发生变化时执行
`npm run bundle:android` 和 `npm run bundle:ios`。业务逻辑变化补充针对性测试。

JS bundle 成功只证明打包链路；APK、iOS 原生构建和真机运行必须单独验收、如实说明。

后端变化在 `backend/` 执行 `uv run pytest -q` 与 `uv run ruff check .`。依赖由 uv.lock 锁定。
真实 Deep Agents 图使用测试模型通过，不等于云端供应商验收；受限文件工具通过，不等于 OS Shell 沙盒已接入。
取消、恢复、队列或文件权限的变化必须覆盖对应集成回归，不能以返回成功状态代替实际回执。
