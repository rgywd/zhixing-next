# 知行 Next 0.2.5：对话体验、共享 Agent 能力与财务闭环

版本 `0.2.5`，Android versionCode `7`，包名 `dev.zhixing.next`。本版汇总 0.2.2 之后的对话界面、首页设置与财务工具修复；预算、目标和饮食规范继续通过聊天调整，不预置个人数字。

0.2.3 因 Linux 并发测试同步问题停止，0.2.4 回归全部通过后因 runner 缺少 Android SDK 命令行工具停止，两次均未生成正式 APK 或公开 Release。本次修正测试并显式安装匹配的 Android SDK、NDK 与 CMake，顺延为 0.2.5；保留已有标签与失败记录。客户端业务与后端运行逻辑不因这两项发布修复改变。

## 本次更新

- 主 Agent、财务和健康共用对话组件。每条回复保留自己的思考和工具过程，流式正文、Markdown、滚动及消息操作使用同一实现；中断或取消后的部分回复明确标注。
- 模型、思考与工具栏单行横向滑动，待发送队列浮在模型栏上方。发送方式放入对话设置，减少输入区和进度提示占用的空间。
- 首页位置天气和手机日历改用标题行刷新图标，精简重复控制。
- 主、直接子 Agent 和受委派子 Agent 共用历史、记忆、附件、公共网页读取、计算、日期和真实报告交付能力；继续遵守目录授权、模型图片能力和本次联网搜索选择。
- 财务修改按字段和项目更新，保留未改预算；批量纠正保持原子性并核验实际保存结果。季度付款、月成本、已付覆盖和下一期预留分开计算，未知交易日期保留范围。
- 公积金提取等已有资产转移不重复计为新增收入；资产核对差额不会自动生成消费，也不会要求重新补整张表。
- 财务报告由账本快照生成并作为实际附件交付，手机可直接预览 Markdown、CSV 和文本，或下载分享。继续报告沿用已核验范围；明确的新范围与余额仍可调整。
- 报告交付后结束工具循环，同时保留用户要求的分析。可恢复的失败回复支持在同一条回复上重试，沿用已保存回执，避免重复记账。
- 设置增加“检查更新”，手动检查 GitHub 最新正式版，不发送服务令牌或个人资料。普通提交和 PR 不运行 Actions，正式版本标签才触发验证、签名构建和发布。

## 安装与覆盖升级

下载 [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.5/zhixing-next-0.2.5-arm64.apk)，直接覆盖同签名旧正式版或预览版，**不要先卸载**。沿用正式证书，保留服务连接、偏好、本机草稿和加密密码库。密码库仅在本机保存，卸载会丢失；主密码无法找回。

应用要求 ARM64、Android 7.0／API 24 起；密码库要求 Android 8.0／API 26 起。JS 随 APK 内嵌，无需 Metro。首次安装仍需自己的服务访问令牌，安装包不包含服务令牌或模型密钥。

## 构建与校验

正式标签 `v0.2.5` 通过 [Android release 工作流](https://github.com/rgywd/zhixing-next/actions/workflows/release.yml) 执行客户端、后端和 Docker 回归，再构建并核验签名 ARM64 APK。构建完成前不把源码检查或预览验收称为正式包验收；实际结果以工作流和发布附件为准。

标准附件为 [APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.5/zhixing-next-0.2.5-arm64.apk)、[构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.5/zhixing-next-0.2.5-arm64.apk.build.json) 和 [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.5/SHA256SUMS)。回执记录源码提交、版本、ABI、签名证书和文件摘要。沿用证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。

发布前，相同业务源码已完成真实模型四轮原话回归：首轮通过同一回复的标准重试一次后完成，其余三轮直接完成，没有追加解释性输入或重复记账；另验证失败续跑、主 Agent 实际转交财务、报告与建议收尾和真实附件下载。报告预览及重试入口已有 Android API 36 模拟器原生验收。正式 Actions APK 的签名、覆盖安装、冷启动、数据保留和检查更新另行核对，不用旧预览截图代替。

## 服务与验收边界

配套后端已更新至数据库 v13，完成备份恢复校验、迁移演练、授权数据修复及公网报告预览／下载核验。本次 APK 发版不重新部署后端或改动账目。

按约定使用 Android 模拟器验收；实体 Android 手机和原生 iOS 未覆盖，iOS JS 打包不等于 iPhone 安装包。检查更新依赖访问 GitHub，网络失败或限流时可稍后重试。源码实现说明见[对话与流式](https://github.com/rgywd/zhixing-next/blob/v0.2.5/docs/CHAT-STREAMING.md)和[发布流程](https://github.com/rgywd/zhixing-next/blob/v0.2.5/docs/DEPLOYMENT.md#客户端-github-发布)。
