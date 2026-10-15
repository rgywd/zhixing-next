# 知行 Next 0.2.2：首页、AI-first 记账与本机密码管理

[v0.2.2 Release](https://github.com/rgywd/zhixing-next/releases/tag/v0.2.2) 汇总 0.2.1 之后的三项改动。版本为 `0.2.2`，Android versionCode 为 `4`，包名仍为 `dev.zhixing.next`。合入前预览已验收，本轮正式 APK 的构建、覆盖安装与下载校验结果记录在 Release 附件中，以附件所列提交和逐项结果为准。

## 本次包含

- [PR #25](https://github.com/rgywd/zhixing-next/pull/25)：今天首页展示实际财务／健康摘要、按需授权的位置天气与只读今日日历，日期跟随手机时间。“开始”和梳理思路只追加到主 Agent 可编辑草稿，保留原输入，由用户自行发送。使用与权限说明见[今天首页](TODAY-HOME.md)。
- [PR #26](https://github.com/rgywd/zhixing-next/pull/26)：首页记开销、财务新增收支及空态入口优先进入财务 AI，继续已有财务会话，不自动发送模板。主知行、财务和健康共用 `AgentChatHeader` 与 `ConversationComposer`，模型、思考、搜索、附件和输入使用同一布局；子 Agent 新会话保留身份。手动补记、原有草稿、预算调整及已有记录纠正、退款、删除继续保留。
- [PR #27](https://github.com/rgywd/zhixing-next/pull/27)：设置内增加“工具箱 → 密码管理”。网站／网址、账号、密码必填，支持辅助邮箱、电话、密保问题和自定义字段。独立主密码、本机加密记录与编辑草稿、显式显示／复制、生成密码和更改主密码；离开、后台或闲置锁定。密码资料不进入 AI、聊天或普通草稿。使用与保护边界见[本机密码管理](PASSWORD-VAULT.md)。

收入、预算、结余目标、身体限制与饮食规范仍可修改，不预置个人数字。底栏仍为首页、生活、知行、施工中、设置；财务与健康属于生活子页，施工功能待定。

## 手机安装与覆盖升级

1. 下载 [ARM64 APK](https://work.8-208-118-119.sslip.io/assistant-downloads/zhixing-next-0.2.2-arm64.apk)，或 [GitHub 附件](https://github.com/rgywd/zhixing-next/releases/download/v0.2.2/zhixing-next-0.2.2-arm64.apk)。应用要求 ARM64、Android 7.0／API 24 起；密码库要求 Android 8.0／API 26 起。
2. 已安装 0.2.1 正式版或同签名首页、AI-first、密码库预览时，直接打开 APK 覆盖安装。保留服务连接、本机偏好、草稿及已有本机密码库；**不要先卸载**。密码库不参与系统备份，卸载会丢失本机库，主密码也无法找回。旧 debug 签名不属于此覆盖升级路径。
3. 首次安装的公开 HTTPS 地址已预填，可在“设置 → 服务连接”修改并填写自己的服务访问令牌。安装包不含访问令牌或供应商密钥，JS 已内嵌，启动无需 Metro。
4. 位置天气和日历可分别按需启用；密码库无需连接知行服务，首次进入单独设置主密码。

沿用正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式 APK 的实际证书、版本和 ABI 由本轮构建回执核对。固定签名方式沿用 [0.2.0 构建说明](RELEASE-0.2.0.md#固定签名构建)。

## 发布附件与验收

本版标准附件为 [APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.2/zhixing-next-0.2.2-arm64.apk)、[build.json](https://github.com/rgywd/zhixing-next/releases/download/v0.2.2/build.json)、[SHA256SUMS.txt](https://github.com/rgywd/zhixing-next/releases/download/v0.2.2/SHA256SUMS.txt)、[ACCEPTANCE.md](https://github.com/rgywd/zhixing-next/releases/download/v0.2.2/ACCEPTANCE.md) 和 [acceptance.json](https://github.com/rgywd/zhixing-next/releases/download/v0.2.2/acceptance.json)。以附件记录的构建提交、文件哈希和逐项结果为准，预览包验收不代替正式包验收。

三项合入前预览已完成 TypeScript、lint、移动回归、Android／iOS JS bundle 和 PR CI，并在 Android 16 ARM64 模拟器分别验收首页、财务 AI 入口与共用界面、密码库原生链路。首页天气实际请求成功，位置使用明确的模拟定位，日历使用临时本机记录；系统日历查看器未显示该临时事件详情，首页只读展示已通过。密码库使用虚构数据，并独立核对原生密文；截屏保护未被绕过。复制限时清理受到后台和进程生命周期限制，不承诺任何状态下均准时清空。

正式发布核对最终提交的适用门禁、正式 APK 的签名、版本、arm64 ABI、同签覆盖后数据与密码库保留、冷启动与关键入口，以及 GitHub／镜像下载哈希，结果由上述验收附件记录。公开文件只包含构建与验证回执，不发布真实密钥、个人记录、截图、连接信息或密码库文件。

本次按约定使用 Android 模拟器，实体 Android 手机和原生 iOS 未验收；iOS JS bundle 不等于原生安装验收，不提供 iPhone 安装包。模拟定位不证明实体 GPS／Wi-Fi 信号质量；原生磁盘耗尽、突然断电未模拟。

## 后端边界

后端目录与 v0.2.1 相同，现网继续使用 `adeeb65`／数据库 v12，不新增数据库迁移或部署。已有真实模型、联合记餐记账和通知实收验收见 [0.2.0 记录](RELEASE-0.2.0.md#发布验收记录)；此前界面与草稿提醒更新见 [0.2.1 说明](RELEASE-0.2.1.md)。
