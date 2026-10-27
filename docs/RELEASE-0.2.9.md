# 知行 Next 0.2.9：聊天照片体验修正

版本 `0.2.9`，Android versionCode `11`，包名 `dev.zhixing.next`。沿用原签名，可覆盖安装；请勿先卸载。

## 本次更新

- 输入框「+ → 照片」直接打开系统相册，可多选。选完即回到输入框，继续打字，点一次发送即可；去掉照片单独的上传确认步骤。
- 草稿只显示紧凑的图片缩略图，隐藏无意义的截图文件名和大小。删除叉号放在图片右上角，不再单占一行；点图片打开全屏预览并左右翻图。
- 未发送照片保存在本机草稿，退出后可恢复。传输失败保留整条消息，重试跳过已有回执的图片；发送后的消息也直接展示图片。
- 欢迎页、主知行、财务和健康共用。每条最多 8 份附件；普通文件仍保留独立入口。

使用及格式边界见[聊天照片](PHOTO-UPLOADS.md)。本版不增加原生依赖、权限或后端迁移；视觉理解取决于所选模型。

## 安装

ARM64 Android 7.0／API 24 起，本机密码库要求 API 26 起。APK 内嵌 JS，无需 Metro，不包含服务令牌或模型密钥。现有用户可在「设置 → 检查更新」下载并由系统确认安装，也可直接下载安装包。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.9/zhixing-next-0.2.9-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.9/zhixing-next-0.2.9-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.9/SHA256SUMS)
- [更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.9/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式标签 `v0.2.9` 触发发布门禁、签名构建与附件验证；普通 PR 不运行 Actions。

## 验证边界

本地执行 typecheck、lint、519 项移动测试及 Android/iOS JS bundle。Android API 36 ARM64 隔离模拟器使用真实本地 API 和合成收据，覆盖欢迎页双选、全屏预览、冷启动草稿恢复、同条消息双图发送、第二张 503 后稳定 ID 重试，以及 320dp、115% 字号、深色键盘布局。没有启动模型 worker 或访问生产服务。

发布工作流另外运行后端、Docker 和发布脚本回归；工作流成功不替代实体手机验收。iOS 原生、实体 Android 手机与真实 iPhone HEIC 选择未覆盖，正式包的签名、版本与覆盖安装应以发布后下载验收为准。
