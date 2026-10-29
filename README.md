# 知行 Next

知行是 DSH 的 React Native 移动出口。DSH 负责模型、执行、线程、工具、插件和文件；App 负责对话呈现、输入、传输、预览和分享。财务与健康作为 DSH 插件能力，使用宿主原生存储，其他出口也可调用。

2026-10-29：财务、健康和联合餐费记录已从 Python 业务服务移入 DSH 插件。App 仅连接 DSH，移除自建记忆、资料库、网络搜索供应商和人格成长入口；搜索与记忆使用宿主已有能力及后续安装的插件，不宣称尚未安装的插件已经可用。没有把旧运行时的工具白名单、轮数或预算加到 DSH 上。迁移步骤与当前验证状态见 [DSH 业务迁移](docs/DSH-BUSINESS-MIGRATION.md)。

聊天支持原输入框编辑、重新回答、消息版本、队列、工具详情和原生 `present` 文件交付。“本对话文件”直接从当前 DSH 线程归集附件与交付，不另建资料库或文件副本；打开交付文件遵循宿主当前文件语义。

手机入口为“首页、生活、知行、施工中、设置”。生活页保留账本、预算、饮食、体重、身体限制与本机健康提醒；同一餐的明确付款和实际饮食可以一起保存、纠正。金额使用十进制计算，不确定日期和未提供的健康事实保持未知。本机密码库、设备权限和只读日历保持独立，不把密码交给 AI。

**[0.2.10 正式发布](https://github.com/rgywd/zhixing-next/releases/tag/v0.2.10)** 已包含前一轮聊天改进。本文的新业务迁移需要配套新客户端，源码合并、测试 APK 和宿主预部署都不等于正式发布。Python 源码保留用于历史参考、一次性迁移和回滚，不再作为新版本运行时依赖。

手机缓存只用于离线阅读及未发送草稿恢复，不成为另一份业务数据或资料库。服务器模型密钥不进入 App。Android 模拟器、正式签名包、实体手机与 iOS 验证分别记录。

## 本地开发

聊天「+ → 照片」支持相册多选，选完直接回到输入框，缩略图只展示照片和右上角叉号；一次发送自动完成图片传输与消息提交。首次对话、主知行、财务和健康共用，本地照片草稿可恢复，失败保留整条消息并重试。普通文件保留独立入口。使用与验证边界见[聊天照片](docs/PHOTO-UPLOADS.md)。

使用当前 Expo SDK 支持的 Node.js LTS；本仓库开发环境为 Node.js 24。依赖使用 npm 与 lockfile。

```sh
npm ci
npm ci --prefix plugins/dsh-zhixing
npm start
```

`npm run android`、`npm run ios` 用于具备相应 SDK 的原生开发环境。DSH 按[插件启动说明](plugins/dsh-zhixing/README.md#启动)配置，手机连接可在设置中修改。正式 App 只接受不含凭据的 HTTPS 服务地址；服务令牌使用手机安全存储，模型密钥留在服务端，安装包不内置令牌或供应商密钥。

## 验证与安装包

```sh
npm run typecheck
npm run lint
npm run test:mobile
npm run bundle:android
npm run bundle:ios
npx expo-doctor
```

DSH 插件执行 `npm run test:dsh` 与 `DSH_BIN=/绝对路径/dsh npm run test:dsh:integration`。修改归档 Python 后端时才在 `backend/` 执行 `uv run pytest -q` 与 `uv run ruff check .`。`bundle:*` 只生成 JS/Hermes 产物。正式 APK 通过[签名构建脚本](scripts/build_android_release.py)生成并内嵌 JS，应用支持 Android API 24 起，密码库要求 API 26 起；本次 APK 仅包含 arm64。相同业务源码的报告预览和失败重试已完成 Android 模拟器原生验收；本轮 Actions 正式包的构建、覆盖安装、检查更新和下载校验另行记录，见[0.2.6 发布说明](docs/RELEASE-0.2.6.md)。首页与密码库的既有验收见[0.2.2 说明](docs/RELEASE-0.2.2.md)，完整业务与通知见[0.2.0 说明](docs/RELEASE-0.2.0.md)。实体 Android 手机和原生 iOS 未覆盖；iOS JS bundle 不等于 iPhone 安装包。

## 入口

- [协作规则](AGENTS.md)与[文档索引](docs/README.md)
- [财务与饮食体重产品文档](docs/FINANCE-HEALTH-PRODUCT.md)与[实施方案](docs/FINANCE-HEALTH-IMPLEMENTATION-PLAN.md)
- [DSH 启动与权限边界](plugins/dsh-zhixing/README.md)
- [历史 Python 后端](backend/README.md)
- [HTTP 与运行接口](docs/API.md)
- [部署与恢复](docs/DEPLOYMENT.md)
- [历史产品说明](docs/PRODUCT.md)

Git 历史独立维护，代码远端为 [GitHub 仓库](https://github.com/rgywd/zhixing-next)。Release 的实际链接、安装包与校验值以对应版本的发布验收记录为准。
