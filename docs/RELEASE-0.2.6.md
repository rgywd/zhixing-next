# 知行 Next 0.2.6：更新兜底、工具调用与子 Agent 协作

版本 `0.2.6`，Android versionCode `8`，包名 `dev.zhixing.next`。本版汇总 0.2.5 之后的更新检查、财务与健康工具优化，以及运行内研究子 Agent 和跨对话只读咨询。

## 本次更新

- 检查更新自动使用 GitHub API、官方 Release 静态清单和已核验缓存；限流时继续取得版本与安装包，离线展示核验时间并保留下载入口。无需 GitHub 令牌。
- 财务工具自动读取真实输入，处理冗余日期字段、月摊计算和兼容参数；未知历史保留已知回顾范围，预算局部修改保留未改字段。来源和回执由程序维护，减少重复填表和原样重试。
- 健康和联餐工具暴露实际可用的嵌套参数，局部纠正保留其它字段。同一顿饮食与餐费由主助手原子记录或纠正，备注不代替实际流水；未知时刻和份量保持未知，明确自然时间不被记录时钟覆盖。
- 主 Agent 可并行启动只读研究子助手、向原助手补充要求、等待和收齐结果。上下文、追加消费、结果版本和真实停止均有回执；长结果需读完实际分页或明确放弃，不能只读首屏就当已收齐。
- 主 Agent 可咨询已有独立对话，沿用目标自身身份和历史；等待让出执行槽，取得实际答复后继续。内部咨询带来源标记，不成为新的用户授权、个人记忆或业务写入权限。
- 文件与网页失败给出具体修正建议，长文本可按真实游标继续读取；主、财务和健康共用工具装配、对话组件与回执处理。
- 手机显示未知用餐／测量时刻的记录说明，等待期间可继续补充要求。已退休的任务和工作入口保持现有产品安排。

## 安装与覆盖升级

下载 [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.6/zhixing-next-0.2.6-arm64.apk)，直接覆盖同签名旧正式版或预览版，**不要先卸载**。沿用正式证书，保留服务连接、偏好、本机草稿和加密密码库。

要求 ARM64、Android 7.0／API 24 起；本机密码库要求 Android 8.0／API 26 起。JS 随 APK 内嵌，无需 Metro。安装包不包含服务访问令牌或模型密钥。

## 构建与校验

正式标签 `v0.2.6` 由 [GitHub Actions](https://github.com/rgywd/zhixing-next/actions/workflows/release.yml) 执行客户端、后端与真实 Docker 回归，再构建签名 APK 并发布。普通提交和 PR 不运行 Actions。

标准附件包含 [APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.6/zhixing-next-0.2.6-arm64.apk)、[构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.6/zhixing-next-0.2.6-arm64.apk.build.json)、[SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.6/SHA256SUMS) 和 [更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.6/app-update.json)。证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。

本地测试、隔离真实 Qwen 验收和完整语义审阅分别核对，源码通过不代替实际安装包验收。正式工作流、下载字节与哈希、签名、同签覆盖安装、冷启动和更新检查的结果另留发布验收回执；完成前不宣称正式构建通过。

## 服务与验收边界

本版配套后端数据库为 v14。升级采用停写完整备份、恢复副本迁移核验与生产数据完整性检查；回滚需要配套旧程序和升级前完整数据，不能仅切回 v13 程序。现有财务和健康数据保留，不重跑旧账目修复。

研究子助手首版只读，最多四个、同时两个，使用根运行预算；路径绑定不是内容快照。进程重启会将遗留活动 child 标为 interrupted，不冒称仍在执行。跨对话首版仅只读咨询，不开放跨对话业务写入或跨主机调度。

按约定使用 Android 模拟器验收。实体 Android 手机与原生 iOS 未覆盖；iOS JS bundle 不代表 iPhone 安装包。详细协议与验证边界见 [Agent 协作](AGENT-COLLABORATION.md)和[工具取舍](TOOL-HARNESS.md)。
