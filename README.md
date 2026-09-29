# 知行 Next

面向用户本人的个人助手，客户端使用 React Native、Expo 和 TypeScript。

产品方向是让用户直接聊天、发截图或操作服务，由知行完成理解与整理。首页、生活、AI、工作、工具箱的导航和页面轮廓已在手机端落地，版式仍可调整。固定财务助手与自建助手已有持久配置、独立会话和委派；财务助手能记录用户明确提供的金额并在生活页展示。截图理解、自动对账与统一资源库尚未接入，详见[产品文档](docs/PRODUCT.md)。

2026-09-23：已实现 SQLite 后端、Deep Agents 会话任务与文件交付链路，并在 myVPS 完成独立部署与真实百炼模型验收。移动端为连接真实后端的功能样板房，版式尚未定案。
用户计划在 Mac mini 到货后将其作为常驻主机，
通过隧道连接 myVPS 公网入口。Mac 配置为 16GB，主模型调用云 API，本地只考虑轻量模型。
迁移后的 myVPS 只承担新知行的公网入口和隧道；助手服务与权威数据放在 Mac mini。Mac 离线时不承诺接收任务。
后端使用 Deep Agents / LangGraph，运行方式和实际边界见[后端说明](backend/README.md)；myVPS 的入口、恢复步骤与已验收范围见[部署说明](docs/DEPLOYMENT.md)和[验收记录](docs/VERIFICATION.md)。Mac 尚未部署。
App 虚拟执行环境与外部 harness 编排后续扩展。

## 本地开发

使用满足当前 Expo SDK 要求的 Node.js LTS；初始化环境为 Node.js 24。

```powershell
npm ci
npm start
```

开发服务器启动后，可以通过匹配 SDK 的 Expo Go 或开发客户端连接。`npm run android`、`npm run ios`
用于本地原生开发构建，需先准备相应 SDK、设备或模拟器。后端按[启动说明](backend/README.md#启动)单独配置。
手机页面用于验证能力与讨论版式；网络请求、草稿存储和会话状态与页面组件分开。

## 验证

```powershell
npm run typecheck
npm run lint
npm run test:mobile
npm run bundle:android
npm run bundle:ios
npx expo-doctor
```

`bundle:*` 生成 `dist/` 下的 JS/Hermes 产物，不是 APK 或 iOS 安装包。原生构建和真机验收另行执行。
本次实际结果与未通过项见[验收记录](docs/VERIFICATION.md)。

## 入口

- [协作规则](AGENTS.md)
- [文档索引](docs/README.md)
- [第一版产品与首次使用](docs/PRODUCT.md)
- [架构讨论稿](docs/ARCHITECTURE.md)
- [后端启动、已实现能力与边界](backend/README.md)
- [HTTP 与运行接口](docs/API.md)
- [myVPS 部署与恢复](docs/DEPLOYMENT.md)

本仓库的 Git 历史独立维护；[GitHub 仓库](https://github.com/rgywd/zhixing-next) 为代码远端。发布渠道和数据迁移方案尚未配置。
