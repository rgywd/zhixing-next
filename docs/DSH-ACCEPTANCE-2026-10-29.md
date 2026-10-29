# DSH 聊天与 Android 模拟器验收

日期：2026-10-29。DSH 首次接入已由 PR #52 合入，聊天体验修正基于 `34de785`。保留现有 App 壳子和宿主能力，将原生记录呈现为可日常使用的对话；本记录不表示生产迁移或正式版本发布。

## 环境

- 官方 `@deepseek-ai/dsh@0.2.2-alpha.2`，独立 `DSH_HOME`、工作目录、SQLite 业务库与本地 HTTPS 代理。
- 确定性测试模型驱动真实 DSH Session Controller、read/write/bash、问答、队列、附件与持久化；没有调用云模型。
- Android 16 / API 36 ARM64 Pixel 6 模拟器，独立包名 `dev.zhixing.next.dshtest`，临时测试签名。原生 Gradle APK 安装运行；基准密度 420，并检查 540 密度下的 320dp 窄屏。
- 仅操作 `emulator-5560`，未操作连接的实体设备。系统 ADB 37 在本机反复崩溃，验收使用独立官方 ADB 36.0.2。

## 已完成的交互与实际回执

| 场景 | 实际结果 |
| --- | --- |
| 原生执行 | App 发起 read → write → bash，工作文件实际变为 `answer = 42`，命令返回 `CHECK_PASSED`；宿主 `subagent`、`plugin_manager`、`schedule_create` 等工具仍提供给模型。 |
| 对话与工具 | 用户气泡、助手 Markdown、思考与工具折叠共用现有组件；历史工具默认收起，展开可见读／写／命令状态。原始事件和未知插件字段在处理记录保留。 |
| 流式滚动 | 长回复逐段增长；手动向上阅读时停留历史并显示返回最新按钮，继续生成不拉回底部；点击后回到最新回复。320dp 夜间截图与原生运行中快照共同核对。 |
| 提问 | 原生 `ask_user_question` 产生选项，App 实际点击 `Proceed` 并提交，宿主继续回复；选项触摸区域至少 44dp。 |
| 停止 | App 点击停止后实际 Shell PID 退出，未生成延迟命令的目标文件；集成测试同时核对原生 `aborted` 回执。 |
| 队列 | Shell 执行中追加消息，App 显示等待条；撤回后原生队列移除且消息未执行。引导操作将原生位置改为 `steering`，后续回复位于补充要求之后。 |
| 消息操作 | 复制有成功反馈；引用助手回复到草稿，可修改后再发，不自动提交。完整原始记录可打开、滚动、关闭。 |
| 图片与文件 | Android 系统相册一次选择两张图片，草稿缩略图可预览、左右翻图；再加一个文本文件，同条消息提交。历史图片按两列显示，认证读取返回 200，全屏预览使用深色背景。 |
| 离线恢复 | 关闭网络代理后冷启动，恢复历史、两张本地照片与文件草稿；首页先显示缓存的 ¥12.34 和 0 餐，并标记待刷新。失败发送保留内容与重试入口。 |
| 丢失回执重试 | 注入“服务器已收消息、代理返回失败”，随后从 App 重试。两次请求使用相同 ID 和三个 receipt，中间没有重复上传；原生日志只有一条用户消息，事件数没有因重试增加。 |
| 宿主重启 | 195 条原生事件恢复，旧图片和工具记录保留；App 在原会话发送 `RESTART-CHECK` 并收到回复。 |
| 业务与主题 | 真实 Python 业务 API 经 DSH 插件转发；首页／生活／财务／健康展示独立测试库。白天、夜间、320dp 窄屏及子页返回生活路径已检查。 |

原始截图、XML、请求轨迹与原生快照保存在本机独立目录：
`/Users/youmin/Developer/Codex/acceptance/zhixing-dsh-emulator-20261029/`。
代表证据：`32-tools-collapsed.png`、`41-question.png`、`43-queue.png`、`45-steering.png`、`53-offline-home.png`、`54-offline-chat.png`、`attachment-verification.json`、`70-photo-grid-final.png`、`71-image-preview-final.png`、`72-restart-reply.png`、`73-raw-records.png`、`77-night-home-scroll.png`、`78-night-finance.png`、`80-night-health.png`、`91-history-start.png`、`93-history-held.png`、`94-stream-latest.png`。该目录含中间失败迭代，结论以上表及标注的最终证据为准；不提交 APK、测试数据或依赖目录。

## 回归与边界

提交前执行客户端类型、lint、移动端测试、Android/iOS JS bundle、DSH 插件单元测试及原生宿主集成回归。集成回归覆盖真实进程取消、重启去重、队列引导／撤回、图片所属会话检查与业务桥接；最终命令结果记录在对应 PR。本次未修改 Python 业务实现。

这轮完成基础聊天可用性，不代表已全面达到 RikkaHub 或 ChatGPT 的产品完整度。复杂插件产物仍可能需要宿主页面；未完成旧聊天、人格成长、自动记忆整理、心跳和通知的迁移。未验收云模型自主修改知行代码、运行完整检查并产出 PR 的闭环；测试模型的工具成功不能替代这项验收。未部署生产，未正式发布，未做原生 iOS 构建或真机验收。
