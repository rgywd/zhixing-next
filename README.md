# 知行 Next

面向本人日常使用的个人助手，使用 React Native、Expo、Python、SQLite 与 Deep Agents / LangGraph。

当前版本收敛为“首页、财务、知行、健康、设置”。主知行与固定财务、健康子 Agent 共用真实服务数据：可以聊天或直接记录收支、饮食和体重，修改预算、身体限制与饮食规范，再查看预算、选择下一餐和回顾。收入、目标与规范均为运行时配置，不预置个人数字。银行直连、自动对账、健康平台同步及远程个性化推送尚未接入。

同一句中的明确餐费与实际饮食可在一个事务内记录、关联和纠正。旧工作、项目管理、任务模式和通用计划入口已移除；历史与聊天运行底座保留，数据库 v12 迁移会停用已有通用计划。附件、记忆、供应商设置和主／子 Agent 对话继续使用原链路。

本机健康提醒滚动安排未来 14 天，每次同步按当前规则更新；“今天不提醒这台手机”可离线取消当天排期。权限、系统限制和长期不打开 App 会影响提醒，尚需实体手机逐项验收。

**0.2.0 正在完成发布验收，源码实现不代表已经部署或发布。** 独立 Android 安装、签名、后端版本和待回填结果见[发布与安装说明](docs/RELEASE-0.2.0.md)。以前文档中的生产回执只证明当时版本，不能代表本轮已上线。主机迁移不作为本次发布依赖。

## 本地开发

使用当前 Expo SDK 支持的 Node.js LTS；本仓库开发环境为 Node.js 24。依赖使用 npm 与 lockfile。

```sh
npm ci
npm start
```

`npm run android`、`npm run ios` 用于具备相应 SDK 的原生开发环境。后端按[启动说明](backend/README.md#启动)配置，手机连接可在设置中修改。正式 App 只接受不含凭据的 HTTPS 服务地址；服务令牌使用手机安全存储，模型密钥留在服务端，安装包不内置令牌或供应商密钥。

## 验证与安装包

```sh
npm run typecheck
npm run lint
npm run test:mobile
npm run bundle:android
npm run bundle:ios
npx expo-doctor
```

后端在 `backend/` 执行 `uv run pytest -q` 与 `uv run ruff check .`。`bundle:*` 只生成 JS/Hermes 产物。正式 APK 通过[签名构建脚本](scripts/build_android_release.py)生成并内嵌 JS，支持 Android API 24 起；本次手机交付以 arm64 APK 为目标。原生安装、真机通知、覆盖升级与发布附件下载校验分别验收，记录在[0.2.0 说明](docs/RELEASE-0.2.0.md)。

## 入口

- [协作规则](AGENTS.md)与[文档索引](docs/README.md)
- [财务与饮食体重产品文档](docs/FINANCE-HEALTH-PRODUCT.md)与[实施方案](docs/FINANCE-HEALTH-IMPLEMENTATION-PLAN.md)
- [后端启动与权限边界](backend/README.md)
- [HTTP 与运行接口](docs/API.md)
- [部署与恢复](docs/DEPLOYMENT.md)
- [历史产品说明](docs/PRODUCT.md)

Git 历史独立维护，代码远端为 [GitHub 仓库](https://github.com/rgywd/zhixing-next)。Release 的实际链接、安装包与校验值以对应版本的发布验收记录为准。
