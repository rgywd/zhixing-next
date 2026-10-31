# 知行 Next 0.2.13：对话设置、照片优化与会话统计

版本 `0.2.13`，Android versionCode `15`，包名 `dev.zhixing.next`。沿用原正式签名，可覆盖安装 0.2.12；请勿先卸载。

## 本次更新

- 在“设置 → 对话设置”修改 DSH 的新会话默认权限，以及运行中发送消息时默认排队或插话。手机保存成功后立即更新；本机缓存保留 24 小时，启动、打开设置或回到前台时按需读取，支持手动刷新。单条消息的发送选择随草稿恢复。
- 相册照片发送前准备更小的传输副本，保留原分辨率、比例和相册原件。高质量编码可能有损；小图、动图、特殊 PNG 和无明显收益的结果保留原文件。文件入口仍发送原始字节，重试复用已准备的照片并跳过已确认上传。
- 输入栏增加上下文圆环与原生压缩入口；每轮回复后显示会话累计统计，包括用时、生成速度、Token 和缓存命中情况。历史快照不会随之后的回复变化。
- 整合云端 Telegram 三月七人格热加载、私聊重启恢复、跨会话记忆和主动陪伴。沿用已启用的用户范围与联系频率，不新增联系人。
- 补充私密变量填写的重启持久化回归，以及照片重试保留排队／插话选择的联合验证。

配套知行 DSH 插件升级到 `0.4.0`。新设置直接使用宿主配置；服务器模型密钥不进入 App。已有会话继续保留各自权限。

## 安装与验证

ARM64 Android 7.0／API 24 起，密码库要求 API 26 起。APK 内嵌 JS，无需 Metro；可在“设置 → 关于 → 检查更新”下载安装。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.13/zhixing-next-0.2.13-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.13/zhixing-next-0.2.13-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.13/SHA256SUMS)
- [更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.13/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式标签触发 Actions 回归、签名构建与下载校验；发布流程补齐新增 TG 插件的锁定依赖安装。

整合源码已通过类型检查、lint、619 项移动测试、49 项 DSH 测试及 Android/iOS JS bundle。独立真实 DSH 宿主覆盖配置保存、版本冲突、原生队列与插话、权限、取消、压缩、文件、重启恢复和私密变量。各功能的 Android 模拟器验收见对应文档。24 小时缓存和跨日联系时段使用可控时钟验证，未等待真实一天；TG 手机实收主动消息、实体 Android、原生 iOS 以及真实 HEIC/HDR 样本仍未验收。正式签名包安装、云端配套部署和发布下载结果单独留存回执。
