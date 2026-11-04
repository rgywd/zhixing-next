# 知行 Next 0.2.14：云端模型控制

版本 `0.2.14`，Android versionCode `16`，包名 `dev.zhixing.next`。沿用原正式签名，可覆盖安装 0.2.13；请勿先卸载。

## 本次更新

- 新增“设置 → 模型控制”，分别选择知行新对话的默认模型和 Telegram 后台模型；TG 也可跟随知行默认。
- 模型目录直接来自 DSH 服务器，没有客户端模型白名单。后续在服务器新增并加载模型后无需更新 App：聊天页在线时约每 5 秒同步；打开模型控制、回到前台或手动刷新时也会读取。离线时保留原有聊天目录，恢复联网后同步。缺少凭据的模型显示为暂不可用。
- 保存等待服务器持久化并回读确认；配置冲突、不可用模型或 TG 正在回复时明确提示，失败后重新读取云端状态。当前对话切换模型不再改变全局默认。
- TG 模型切换保留聊天、记忆和轮询实例，接下来的回复及主动消息使用新模型。沿用现有联系偏好。
- 配套云端已加入 GPT-6 Luna 和 GPT-6.1 Terra，通过 OpenAI Responses 调用，并保留原有 DeepSeek、Qwen 模型。供应商密钥仅保存在服务器。已验证 DSH 原生工具回路；OpenAI 托管搜索等附加工具尚未接入。

配套 App 插件为 `0.5.0`，TG 陪伴插件为 `0.1.2`。服务器配置和选择规则见 [DSH 模型控制](DSH-MODELS.md)。

## 安装与验证

ARM64 Android 7.0／API 24 起，密码库要求 API 26 起。正式 APK 内嵌 JS，无需开发服务器；可在“设置 → 关于 → 检查更新”下载安装。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.14/zhixing-next-0.2.14-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.14/zhixing-next-0.2.14-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.14/SHA256SUMS)
- [更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.14/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式标签触发 Actions 回归、签名构建与下载校验，实际结果以工作流和发布附件为准。

原生 DSH 集成覆盖默认模型持久化、实际执行模型、当前对话隔离、TG 跟随默认、闲置恢复、重启和不重建轮询实例。本机及云端隔离宿主中，两个 OpenAI 模型均完成 Responses → bash → 工具结果 → 最终回复；没有向真实 TG 发送测试消息。移动回归覆盖 App 启动后服务器增加未知供应商和模型，聊天目录及默认／TG 选择器在同步后出现新项。

新页面已在 Android API 36 ARM64、320dp 模拟器的开发容器中验证实际选模、保存回读及日夜主题。正式签名包的覆盖安装、更新清单与目录同步结果另留发布验收回执；实体 Android 与原生 iOS 尚未验收。
