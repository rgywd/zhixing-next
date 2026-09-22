# 知行 Next 协作入口

本仓库是新建的 React Native App，架构独立于其他知行子仓。上层工作区规则仍适用。

## 入口与边界

- 先读 [README.md](README.md) 和 [文档入口](docs/README.md)。
- [架构讨论稿](docs/ARCHITECTURE.md) 区分用户已确认方向与待讨论建议；建议不能当作已实现能力。
- 不自动移植旧仓的模块、协议、数据格式或部署配置；复用需有当前需求和代码证据。
- 第一阶段聚焦服务器执行，后端优先 Deep Agents / LangGraph；App 虚拟执行环境及外部 harness 编排后续扩展。
- 按需增加模块，不为后续扩展建立空实现、通用适配器或调度平台。
- 从 `main` 切短分支；存在其他任务或脏改动时使用干净 worktree。
- 不提交凭据、依赖目录或构建产物，不把服务端模型密钥放进 App。

## Expo 与原生代码

- 以 `package.json` 为版本依据；修改 Expo API 前查对应 SDK 版本的官方文档。
- 通过 `npx expo install <package>` 选择兼容依赖，使用 npm 并提交 lockfile。
- `android/`、`ios/` 由 Expo 生成；原生配置放入 `app.json` 或 config plugin。
- Expo Go 用于基础调试；需要额外原生能力时使用 development build。
- 构建工具和发布服务分开选择；不因使用 Expo 自动配置云服务或发布。

## 验证

交付前执行 `npm run typecheck` 与 `npm run lint`。客户端源码、依赖或构建配置发生变化时执行
`npm run bundle:android` 和 `npm run bundle:ios`。业务逻辑变化补充针对性测试。

JS bundle 成功只证明打包链路；APK、iOS 原生构建和真机运行必须单独验收、如实说明。
