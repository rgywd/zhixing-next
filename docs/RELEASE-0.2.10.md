# 知行 Next 0.2.10：DSH 对话与本机缓存

版本 `0.2.10`，Android versionCode `12`，包名 `dev.zhixing.next`。沿用原签名，可覆盖安装；请勿先卸载。

## 本次更新

- 重做 AI 页的欢迎页、导航、输入工具栏、日夜配色与文件卡片。编辑直接回到原输入框，普通草稿独立保留；助手回复直接重答，消息下方切换实际版本。
- 新增 DSH 移动出口，复用宿主会话、模型、工具、提问、队列、取消与历史。文件交付直接消费原生 `present`，自动出现可预览和分享的卡片；工具详情优先显示文件内容、命令和结果，技术记录按需展开。
- 改善长回复、Markdown 表格、中文文件链接及长文件名预览；展开工具过程保持阅读位置，恢复编辑时定位原消息，窄屏发送和取消不被键盘遮挡。
- 新增本机读取缓存：已有会话、读取过的聊天及首页摘要先显示本机副本，再同步更新；断网仍可查看已有内容。不是离线发送队列，也不代表所有附件已下载。
- 修正首页快捷入口和位置天气栏；保留上一版的照片多选、图片草稿与一次发送体验。

本版 APK 不自动切换生产服务器，也不迁移旧会话或数据。连接 DSH 插件服务后使用新的原生能力；旧 Python 服务继续兼容。DSH 宿主按[插件说明](../plugins/dsh-zhixing/README.md)独立配置，模型密钥留在服务器。切换历史不回滚已经执行的工具操作；原生交付文件打开的是当前工作区内容。

## 安装

ARM64 Android 7.0／API 24 起，本机密码库要求 API 26 起。APK 内嵌 JS，无需 Metro；不包含服务令牌或模型密钥。可从「设置 → 检查更新」下载并由系统确认安装，也可使用以下正式附件。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.10/zhixing-next-0.2.10-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.10/zhixing-next-0.2.10-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.10/SHA256SUMS)
- [更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.10/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式标签 `v0.2.10` 触发发布回归、签名构建与附件验证；普通 PR 不运行 Actions。

## 验证边界

聊天源码已使用真实官方 DeepSeek 对话完成 Android 16 模拟器验收：周末计划编辑／重答／版本切换、四人晚饭改六人并生成中文文件、预览和系统分享，以及日夜主题、320dp 键盘与阅读位置。截图与完整记录见[AI 对话重做验收](AI-CHAT-REDESIGN-2026-10-29.md)。本机缓存离线与恢复验证见[本机缓存](LOCAL-CACHE.md)。

本地发布检查包括类型、lint、移动端测试、双平台 JS bundle 和发布脚本回归。DSH 原生集成覆盖真实工具、队列、取消、重启、附件、消息版本及文件交付；确定性测试模型与真实云模型验收分别记录。

标签工作流另执行后端及 Docker 回归，并校验正式证书、版本、ABI、APK 摘要和更新清单。正式包来源及哈希以 Release 构建回执为准，发布完成还需下载核对及覆盖安装验收。实体手机和原生 iOS 未覆盖；JS bundle 不等于原生 iOS 安装包。
