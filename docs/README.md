# 文档入口

- [RikkaHub 与知行 DSH 对话详情产品对照](CHAT-EXPERIENCE-RIKKAHUB-COMPARISON.md)：布局、消息与输入、52 个界面条目、功能差距、实施优先级及验收清单；附[模拟器截图](CHAT-EXPERIENCE-RIKKAHUB-SCREENSHOTS.md)。

- [DSH 插件接入](../plugins/dsh-zhixing/README.md)：现有 App 壳子、原生宿主会话、工具事件、问答／取消、业务桥接与验收命令。

- [DSH 聊天与 Android 模拟器验收](DSH-ACCEPTANCE-2026-10-29.md)：消息展示、原生工具、队列、附件重试、历史恢复及测试模型边界。

- [本机缓存与同步](LOCAL-CACHE.md)：会话、聊天、首页摘要与手机信息的本机恢复、后台更新、隔离和验证边界。

- [0.2.9 聊天照片体验修正](RELEASE-0.2.9.md)：选图即入草稿、纯图片缩略图与一次发送，versionCode 11，同签覆盖升级。

- [0.2.8 相册多选与照片批量上传](RELEASE-0.2.8.md)：独立照片入口、多图预览、批量上传与失败重试，versionCode 10，同签覆盖升级。

- [聊天照片](PHOTO-UPLOADS.md)：直接多选到输入框、纯图片缩略图、一次发送、持久草稿与重试，以及原生验证边界。

- [App 更新与 GitHub 访问诊断](APP-UPDATES.md)：匿名 API 限流复现、清单优先、双源错误，以及 App 内下载与系统安装确认。

- [0.2.7 人格成长与 App 内更新](RELEASE-0.2.7.md)：Android 内下载、校验、系统安装确认，以及清单优先和更新失败诊断；纳入已部署的 v15 成长与心跳客户端。

- [人格成长与主动服务验收](ACCEPTANCE-MUSE-GROWTH-2026-10-23.md)：本地回归、真实 Qwen、首次语义失败与修复，以及部署和通知边界。

- [人格成长与主动服务](MUSE-GROWTH.md)：保留 Muse 的灵魂与成长表达；演化人格、专门的主动偏好、目标跟进与 worker 心跳，以及当前记忆来源和交付边界。

- [核心偏好与明确人物称谓验收](ACCEPTANCE-CORE-MEMORY-2026-10-22.md)：Qwen 29 轮、62 项检查，核心偏好跨聊天、歧义、关系变化、纠正与遗忘。

- [助手基底与记忆真实模型验收](ACCEPTANCE-MUSE-MEMORY-2026-10-22.md)：Qwen 实聊、全库召回、来源、纠正与遗忘，以及无关记忆和额外报告修复。

- [助手提示词基底](ASSISTANT-BASE.md)：Muse 人格与通用原则复用、知行身份替换与实际工具边界。

- [0.2.6 更新兜底、工具与子 Agent 协作](RELEASE-0.2.6.md)：正式标签 Actions 签名 ARM64 包、versionCode 8、v14 完整备份与迁移、只读研究及跨对话咨询；实际构建、下载与模拟器验收另留回执。

- [工具调用体验与 harness 取舍](TOOL-HARNESS.md)：对照 Codex、OpenCode、Pi，简化参数、自动合并、可修复失败与验证边界。
- [Agent 协作与工具可用性](AGENT-COLLABORATION.md)：结构化业务工具、自然输入评测、运行内只读研究子 Agent、跨独立对话持久只读咨询与恢复边界。

- [对话布局与流式显示](CHAT-STREAMING.md)：横向工具栏、对话设置、正文／思考／工具事件、草稿目标绑定和验证边界。

- [0.2.5 对话体验、共享 Agent 能力与财务闭环](RELEASE-0.2.5.md)：正式标签触发 GitHub Actions 验证、签名构建及发布；versionCode 7、同签覆盖安装、报告预览与失败重试，实际结果以工作流和发布附件为准。

- [0.2.2 首页、AI-first 记账与本机密码管理](RELEASE-0.2.2.md)：本次正式 ARM64 APK、versionCode 4、同证书覆盖升级及本机密码库保留；正式构建与验收结果以 Release 附件为准。

- [本机密码管理](PASSWORD-VAULT.md)：设置中的工具箱、独立主密码、本机加密记录与草稿、自动锁定和剪贴板保护；不进入 AI 或云同步。

- [今天首页与手机信息](TODAY-HOME.md)：系统融合定位／天气、只读今日日历、手机时间和主 Agent 草稿交接；0.2.2 纳入范围与验证边界。

- [0.2.1 界面更新与修复汇总](RELEASE-0.2.1.md)：上一正式版的生活／财务／健康／主 Agent 界面和一次性草稿提醒；历史安装包、验收与哈希见对应 Release 附件。

- [0.2.0 安装、签名构建与发布验收](RELEASE-0.2.0.md)：已发布的正式 ARM64 APK、`adeeb65`／后端 v12、真实模型八阶段及补充检查、Android 模拟器原生验收、下载校验与未覆盖边界。

- [财务与饮食体重管理产品文档](FINANCE-HEALTH-PRODUCT.md)：本版记录、可修改目标与饮食约定、推荐和监督的产品约定；实际交付以 0.2.0 发布验收为准。
- [财务与饮食体重管理实施方案](FINANCE-HEALTH-IMPLEMENTATION-PLAN.md)：数据与 Agent 职责、本机提醒、实施切片和发布约定；已完成结果见 0.2.0 发布验收。
- [GitHub AI 财务与饮食体重管理调研](AI-FINANCE-HEALTH-RESEARCH-2026-10-14.md)：十三个项目的 AI 源码、维护与许可证快照，以及借鉴取舍。

- [2026-10-05 草稿恢复与记忆纠错](DAILY-CONTINUITY-2026-10-05.md)：欢迎页持久保存、发送回执恢复、记忆搜索/纠正与旧整理隔离。
- [2026-10-04 移动端收尾验收](MOBILE-FOLLOWTHROUGH-2026-10-04.md)：常用与最近、项目、财务、计划、资源、返回路径及仍待推进的边界。

- [主智能体可靠执行计划](AGENT-HARNESS-PLAN.md)：重试与预算、长任务交付、历史与外部工具、持续验收的实施顺序和完成条件。
- [执行闭环实际验收](HARNESS-ACCEPTANCE-2026-09-30.md)：真实 Qwen 问答续做与 CSV 交付、GitLab 读取、Docker 回归、配置和 v11 升级边界。

- [产品与首次使用](PRODUCT.md)：当前首页、生活、知行、施工中、设置五入口；财务与健康归属生活子页，施工功能待定；后附历史设计。
- [架构讨论稿](ARCHITECTURE.md)：SQLite 优先的后端、持久任务调度、执行权限与待验证的接入方案。
- [个人助手记忆讨论稿](MEMORY.md)：自然形成、按需整理和获取的记忆，不要求用户提供原文证据。
- [开发与验证](../README.md)：本地启动和验证命令。
- [客户端 GitHub 发布](DEPLOYMENT.md#客户端-github-发布)：仅正式版本标签运行 Actions、固定签名 APK 与校验附件、设置中的手动检查更新。
- [共享 UI](UI.md)：日夜主题、共享组件和主页面／子页面的接入方式。
- [安卓手机能力](ANDROID-CAPABILITIES.md)：通知栏权限与测试、系统日历编辑器、单次定位和实际能力边界。
- [安卓手机能力验收](ANDROID-CAPABILITIES-ACCEPTANCE-2026-09-30.md)：独立 APK、通知栏实收、日历保存回执、定位生命周期与窄屏验证。
- [日夜主题验收](THEME-ACCEPTANCE-2026-09-29.md)：全 App 配色、切换持久化、对比度与 Android 系统外观联动。
- [模型思考与提示栏验收](MODEL-THINKING-ACCEPTANCE-2026-09-30.md)：真实 Qwen 档位与工具回合、六家模型 Android 选项、悬浮提示与恢复边界。
- [模型思考适配](MODEL-THINKING.md)：名称匹配、模型版本、思考档位与请求参数。
- [供应商与模型管理](PROVIDER-MANAGEMENT.md)：旧版 RikkaHub 梳理、手机配置、模型发现与测试、v10 迁移和回滚。
- [设置入口验收](SETTINGS-ACCEPTANCE-2026-09-29.md)：分组设置、模型供应商、搜索服务管理与窄屏返回验证。
- [对话界面验收](UI-ACCEPTANCE-2026-09-29.md)：品牌工具栏、底部弹层、窄屏键盘和断线注入结果。
- [后端实现与运行](../backend/README.md)：当前可运行能力、配置、恢复行为与未实现边界。
- [通用执行能力升级](HARNESS-UPGRADE.md)：图片输入、Docker 执行、浏览器、产物交付的启用步骤与本地验收。
- [中断恢复与授权](RECOVERY-AND-AUTHORIZATION.md)：按步骤续做、文件版本核对、操作批准、真实回执及 v9 迁移。
- [myVPS 部署与恢复](DEPLOYMENT.md)：独立目录、systemd、HTTPS 路由、运行观察、备份与回滚。
- [接口契约](API.md)：HTTP、持久队列和运行时接口。
- [首条链路验收](VERIFICATION.md)：已执行检查、未通过的环境验收与真实模型接入步骤。
- [2026-09-29 实际使用验收](ACCEPTANCE-2026-09-29.md)：真实 Qwen、图片与表格、手机批准和进程中断恢复，以及发现问题后的修复。

代码与实际验证优先于讨论稿。尚未实现的建议不得描述为现有能力。
