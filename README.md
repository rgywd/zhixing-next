# 知行 Next

独立的新一代知行 App，使用 React Native、Expo 和 TypeScript。

2026-09-22 初始化：代码仅包含移动端启动页面。用户已确认服务器优先，后端优先 Deep Agents / LangGraph；
后端与代码沙盒处于[架构讨论](docs/ARCHITECTURE.md)阶段，尚未实现。App 虚拟执行环境与外部 harness 编排后续扩展。

## 本地开发

使用满足当前 Expo SDK 要求的 Node.js LTS；初始化环境为 Node.js 24。

```powershell
npm ci
npm start
```

开发服务器启动后，可以通过 Expo Go 或兼容的开发客户端连接。`npm run android`、`npm run ios`
用于打开相应目标，需先准备设备或模拟器。当前起点为官方空白模板，未启用额外原生模块。

## 验证

```powershell
npm run typecheck
npm run lint
npm run bundle:android
npm run bundle:ios
npx expo-doctor
```

`bundle:*` 生成 `dist/` 下的 JS/Hermes 产物，不是 APK 或 iOS 安装包。原生构建和真机验收另行执行。

## 入口

- [协作规则](AGENTS.md)
- [文档索引](docs/README.md)
- [架构讨论稿](docs/ARCHITECTURE.md)

本仓库的 Git 历史独立维护；远程仓库、发布渠道和数据迁移方案尚未配置。
