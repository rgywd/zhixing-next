# 知行 Next 0.2.12：对话菜单、权限与私密变量

版本 `0.2.12`，Android versionCode `14`，包名 `dev.zhixing.next`。沿用原正式签名，可覆盖安装 0.2.11；请勿先卸载。

## 本次更新

- 对话标题放在顶部并加粗，下方显示“知行：模型名称”。输入框保留紧邻的模型、思考和权限图标。
- 右上角就地展开 box 菜单，依次提供对话名称、分享、在聊天中查找、当前主题和删除；改名、主题与删除确认也在同一 box 内完成。
- 权限直接使用 DSH 的“仅可查看”“工作区内修改”“完全访问”，分别显示眼睛、手掌与红色盾牌，等待宿主真实回执后更新。
- 新增私密变量填写卡：知行提出用途和变量名，你可以改名，一次填写多个 Key、Token 或其他值。独立接口保存到 DSH 原生凭据，模型只收到变量名和状态，后续原生命令通过环境变量使用。密码式输入，切到后台清空未提交值，同名替换需要勾选。

可对知行说“用私密变量填写卡向我索取 Telegram Bot Token”。变量名使用 `DSH_SECRET_` 前缀，后面的名称可编辑。值用于当前 DSH 工作区，不写进聊天消息或手机草稿，不修改登录环境；后续命令生效。工具返回已知私密值时隐藏结果。完全访问下的程序仍能读取变量，不能隔离恶意程序或任意编码、外传，详见[私密变量](PRIVATE-VARIABLES.md)。

配套知行 DSH 插件为 0.3.0。删除对话等待原生执行停止，移除 App 列表与访问入口；原生归档和工作区文件保留。

## 安装与验证

ARM64 Android 7.0／API 24 起，密码库要求 API 26 起。APK 内嵌 JS，无需 Metro，不包含模型密钥或服务令牌。可在“设置 → 关于 → 检查更新”中下载安装。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.12/zhixing-next-0.2.12-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.12/zhixing-next-0.2.12-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.12/SHA256SUMS)
- [更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.12/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式标签触发 Actions 回归、签名构建和下载校验。

本地验证覆盖客户端类型、lint、移动端与插件测试、Android/iOS JS bundle，以及独立真实 DSH 宿主的权限、取消、删除、私密变量注入、重启和会话日志。私密值采用随机测试凭据。发布工作流、配套服务部署及正式 APK 安装分别验收，以实际回执为准。实体 Android 手机与原生 iOS 留待单独验收。
