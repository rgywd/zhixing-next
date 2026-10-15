# 知行 Next 0.2.1：界面更新与修复汇总

[v0.2.1 Release](https://github.com/rgywd/zhixing-next/releases/tag/v0.2.1) 汇总 0.2.0 之后已合入的界面改动与草稿修复。版本为 `0.2.1`，Android versionCode 为 `3`，包名仍为 `dev.zhixing.next`。发布状态、实际构建提交和验证结果以 Release 及其附件为准。

## 本次包含

- [PR #19](https://github.com/rgywd/zhixing-next/pull/19)：财务和健康归入“生活”，页内返回和 Android 返回均回到生活；原工作位置改为“施工中 / 功能待定”。
- [PR #20](https://github.com/rgywd/zhixing-next/pull/20)：财务与健康采用统一的周期顶栏、圆角分区、大数字和双列指标，记录、调整与助手入口保留。
- [PR #21](https://github.com/rgywd/zhixing-next/pull/21)：主 Agent 欢迎页增加快捷话题、四张入口卡和饮食生活入口；模型、思考和搜索选择移到输入框上方。点击话题只追加草稿，服务状态取实际连接结果。
- [PR #22](https://github.com/rgywd/zhixing-next/pull/22)：模型品牌图标移除背景底板，夜间 Qwen 图标调整对比度。
- [PR #23](https://github.com/rgywd/zhixing-next/pull/23)：健康与财务的未完成编辑改为一次性悬浮提醒，6 秒后自动消失，同一草稿不反复提示；未修改的表单返回后不留草稿，实际输入和未确认提交仍保留，可从记录入口恢复。

预算、收入、结余目标、身体限制与饮食规范仍由用户调整。本版没有新增语音转写；财务和健康业务闭环沿用 0.2.0。

## 手机安装与覆盖升级

1. 下载 [最新 ARM64 APK](https://work.8-208-118-119.sslip.io/assistant-downloads/zhixing-next-0.2.1-arm64.apk)，或 [GitHub 附件](https://github.com/rgywd/zhixing-next/releases/download/v0.2.1/zhixing-next-0.2.1-arm64.apk)。适用于 ARM64、Android 7.0 及以上。
2. 已安装 0.2.0 正式版或同签名预览版时，直接打开 APK 覆盖安装，保留服务连接、本机偏好与草稿。无需先卸载；旧 debug 签名不属于此覆盖升级路径。
3. 首次安装仍需在“设置 → 服务连接”填写自己的服务访问令牌；公开 HTTPS 地址已预填并可修改。APK 不含服务令牌或供应商密钥，启动不依赖 Metro。
4. 从“生活”进入财务与健康；从“知行”进入主 Agent。

沿用的正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。公开文件校验见 [SHA256SUMS.txt](https://github.com/rgywd/zhixing-next/releases/download/v0.2.1/SHA256SUMS.txt)，构建来源、包内 ABI 和版本见 [build.json](https://github.com/rgywd/zhixing-next/releases/download/v0.2.1/build.json)。固定签名构建方式沿用 [0.2.0 构建说明](RELEASE-0.2.0.md#固定签名构建)。

## 验证与后端边界

本版发布检查包括 TypeScript、lint、全部移动回归、Android／iOS JS bundle、四项 PR CI，以及正式签名 APK 的 Android 模拟器覆盖安装、冷启动、页面与返回路径验收。具体执行结果见 [ACCEPTANCE.md](https://github.com/rgywd/zhixing-next/releases/download/v0.2.1/ACCEPTANCE.md) 和 [acceptance.json](https://github.com/rgywd/zhixing-next/releases/download/v0.2.1/acceptance.json)。公开回执只列构建与布尔验证结果；个人界面截图、草稿、连接信息和私有备份不发布。

后端目录与 v0.2.0 完全相同，现网继续运行 `adeeb65` 和数据库 v12，不需要数据库迁移。本次不重复更改提醒或业务执行逻辑；真实模型、联合记餐记账、通知实收及生产部署的既有验收见 [0.2.0 记录](RELEASE-0.2.0.md#发布验收记录)。本次按约定使用 Android 模拟器，实体手机未验收；iOS 只验证 JS bundle，不提供 iPhone 安装包。
