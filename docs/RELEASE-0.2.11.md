# 知行 Next 0.2.11：DSH 原生业务与文件传输

版本 `0.2.11`，Android versionCode `13`，包名 `dev.zhixing.next`。沿用原签名，可覆盖安装 0.2.10；请勿先卸载。

## 本次更新

- 财务、健康和联合餐费进入 DSH 原生业务插件，保留原账本、预算、健康事实、纠错与重试去重，不再依赖 Python API 或 worker。
- 移除独立记忆、资料库、搜索供应商和旧人格管理入口。搜索、记忆、线程和文件处理由 DSH 及其插件负责；App 保留传输、展示、预览、分享和必要的本机缓存。
- “本对话文件”直接归集当前线程的原生附件和交付，可搜索、预览和分享。文件交付使用原生 `present`，打开的是当前文件内容。
- 记账工具自动取得当前线程和来源消息，不再要求用户或模型寻找会话 ID。创建对话会实际应用选定模型，先上传文件再输入文字时由宿主自动命名。

模型密钥保留在宿主。原服务地址和连接令牌沿用，财务健康数据完整迁移；旧对话、记忆、偏好与附件保留为可读的工作区归档，不伪造成原生线程，也不自动恢复暂停的任务。需要新的记忆插件时可以在对话中让 DSH 安装配置。

本版配套 DSH 服务，0.2.10 的旧资源接口已退役，建议与服务切换一起升级。切换须冻结旧写入、完整备份、核对最终导入后再停用旧服务；步骤和回滚边界见 [DSH 业务迁移](DSH-BUSINESS-MIGRATION.md)。反向代理不再沿用旧 Python 的 25 MiB 上传上限，文件策略由宿主决定。

## 安装与验证

ARM64 Android 7.0／API 24 起，本机密码库要求 API 26 起。APK 内嵌 JS，无需 Metro，不包含模型密钥或服务令牌。可在「设置 → 检查更新」中下载，由系统确认安装。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.11/zhixing-next-0.2.11-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.11/zhixing-next-0.2.11-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.11/SHA256SUMS)
- [更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.11/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式标签触发 GitHub Actions 验证、签名构建与下载校验；普通 PR 不运行 Actions。

源码已用真实 DeepSeek 在独立 Android 模拟器中验证餐费与饮食联合记录、原记录纠正、健康限制、手动体重，以及文件上传、读取、Markdown 交付、预览和系统分享。生产机预部署已用原有 DeepSeek 和 Qwen 配置验证真实回答、原生工具与搜索，并核对旧业务表和附件原件。测试数据写入隔离宿主，不写入用户账本。

签名包发布、覆盖升级与生产切换的实际结果以 Release 回执和部署验收记录为准，不能从源码测试推断。实体 Android 手机和原生 iOS 未覆盖；iOS JS bundle 不等于 iPhone 安装包。
