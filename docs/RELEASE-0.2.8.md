# 知行 Next 0.2.8：相册多选与照片批量上传

版本 `0.2.8`，Android versionCode `10`，包名 `dev.zhixing.next`，正式 ARM64 APK。沿用既有签名，可直接覆盖安装并保留服务连接、偏好、草稿与本机加密密码库；不要先卸载。

## 本次更新

- 聊天“+ → 添加资料”新增独立“选择照片”入口，可从系统相册一次选择多张照片；原文件入口也支持多选。主知行、财务和健康共用。
- 上传前显示照片缩略图、名称与大小，可移除选错的项目。点击“上传 N 份并加入草稿”后逐项上传，显示进度，成功项直接进入当前对话草稿；回到聊天可补充文字并一起发送。
- 每条消息最多 8 份附件，已有草稿计入额度，每份上传最多 20 MiB。单项失败保留剩余项供重试，不重复上传已收到回执的文件；关闭或切换会话时，迟到结果不会进入其他聊天。
- 支持照片格式适配与过大照片压缩，保留系统相册原件。Android 使用系统照片选择器，不新增相机、录音或全相册读取权限。

使用说明与测试范围见[照片批量上传](PHOTO-UPLOADS.md)。照片理解仍取决于所选模型的图片输入能力。本版沿用既有后端接口与 schema v15，不包含后端生产部署或数据库迁移。

## 安装与附件

要求 ARM64、Android 7.0／API 24 起；本机密码库要求 API 26 起。JS 内嵌，无需 Metro。APK 不包含服务访问令牌或模型密钥。已安装 0.2.7 可从“设置 → 检查更新”下载，再确认 Android 系统安装；也可使用下方安装包。

正式发布由标签 `v0.2.8` 触发 [Android release](https://github.com/rgywd/zhixing-next/actions/workflows/release.yml)，完成回归、签名构建、附件校验后公开。普通提交与 PR 不运行 Actions。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.8/zhixing-next-0.2.8-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.8/zhixing-next-0.2.8-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.8/SHA256SUMS)
- [官方更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.8/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式构建、下载校验与覆盖升级以本次发布回执为准；本地测试和 JS bundle 不代替正式包原生验收。

## 验证边界

照片功能已在独立 Android API 36 ARM64 模拟器上通过系统相册双选、缩略图、真实本地 API 批量上传及同条消息双附件提交；覆盖 320dp 宽度、115% 字号与深色模式。使用合成图片与隔离服务，没有请求生产模型。自动化覆盖剩余额度、部分失败、稳定 ID 重试、格式转换、关闭和会话切换、草稿保存恢复与同条消息提交。

发布门禁包含 TypeScript、ESLint、移动测试、Android/iOS JS bundle，以及标签触发的后端、Docker 和发布脚本回归。实体 Android 手机、iOS 原生与真实 iPhone HEIC 选择未覆盖；iOS JS bundle 不等于 iPhone 安装包。
