# 首条可用链路验收

日期：2026-09-23。核心实现提交：`5335a2e`；百炼接入与 myVPS 发布包：`9d59b663157861fe754d149d39f67a7d92c09105`。
手机端是功能样板房，页面版式尚未定案。

## 已验证

| 检查 | 结果 |
| --- | --- |
| 后端 pytest | 87 项通过；使用真实 SQLite、Deep Agents 图和持久 checkpoint，模型由测试注入 |
| Python Ruff | 通过 |
| 手机 TypeScript、ESLint | 通过 |
| 手机 API、草稿与重试测试 | 9 项通过，包含 Expo 原生上传 MIME 回归 |
| Android / iOS JS 与 Hermes bundle | 两端通过；不是原生安装包 |
| Expo Doctor | 21/21 通过 |
| 独立 API / worker 进程启动 | 通过；认证请求可达，worker 在线；缺少模型配置时运行明确失败，不返回模拟回答 |
| Android 调试 APK | 构建通过，269 个任务，包含 arm64-v8a / x86_64；本机使用 NDK 28.2 和缩短的 CMake 临时目录 |
| Android 模拟器干净启动 | 通过，欢迎页及连接表单正常显示；使用独立的只读 API 35 模拟器 |
| 百炼新加坡真实模型 | `qwen3.8-flash` 文本、工具调用和工具结果续答通过；工具参数与最终答案正确 |
| 百炼 Responses 实调 | 同模型通过新加坡 Responses 接口，精确返回 `OK`；工具闭环未测 |
| myVPS 公网链路 | `/assistant/healthz` 200、未授权 `/assistant/v1/status` 401；认证状态的模型与 worker 均就绪 |
| myVPS 真实任务 | API → SQLite → worker → Deep Agents → 物理文件工具 → HTTPS 下载通过；下载内容与上传的 12 字节原文一致 |
| myVPS Queue / Steer | 同会话两条 Queue 按顺序完成并分别返回 A、B；运行中 Steer 被接受且应用，只写出修正后的 `new.md` |
| myVPS 定时计划 | 一次性计划到点由后台 worker 执行，运行完成并返回“定时任务成功。” |
| Android 原生 HTTPS | 独立模拟器登录并加载历史；新会话真实云聊天、文本文件选择/上传、任务写出及下载分享 `report.md` 已通过 |
| myVPS 服务重启 | 无在途运行时重启新 API 与 worker，模型/worker 恢复就绪，既有运行及报告文件保持可读且哈希一致 |

后端集成测试实际经过 API 提交、SQLite 入队、worker 领取、Deep Agents 调用文件工具、
结果落库与文件下载。覆盖 Queue 顺序、Steer 持久应用、取消在途文件操作、保留待处理队列、
重启后的中断标记、定时去重及跨目录授权。手机测试覆盖客户端契约和重试状态，不能代替真机交互验收。

调试 APK 大小 82,815,471 字节，SHA-256：
`25f830d44bbd2332aad52d26b192ba00ca2ea25b8ef6d5ccf7d5934f7521e59a`。
它不包含离线 JS bundle，必须先启动 Metro 再打开 App；不是独立安装包或正式发行制品。
Windows 上本次 Metro 使用 IPv4 loopback，避免仅监听 IPv6 时模拟器无法连接。
首次未连上 Metro 后，仅 Reload 曾出现原生 React Surface 未重新挂载；在 Metro 就绪后干净启动通过。
NDK / CMake 调整只用于本机生成目录，没有修改系统 SDK、第三方源码或提交原生生成文件。

## myVPS 与供应商实调

发布包 SHA-256：`e2ecad76a966a999122d4da1dfa1efb49681738fbd7e834aafeef79af81697f6`；
本地与服务器一致。代码位于 `/opt/zhixing-next/releases/9d59b663157861fe754d149d39f67a7d92c09105`，
API 与 worker 使用独立的 systemd 服务、`127.0.0.1:8791` 和 `/var/lib/zhixing-next`。
密钥仅存在服务器受限环境文件，未写入仓库或验收输出。HTTPS 复用现有 Work 主机的 `/assistant` 路径；
修改 Nginx 前已备份，`nginx -t` 通过，旧 Work 和旧知行健康检查在前后均为 200。

本机直连百炼 Chat 接口时，文本精确返回 `OK`；一次工具请求正确给出加法参数，工具结果回传后精确返回 `42`。
供应商该工具轮的 `finish_reason` 为 `stop`，但 LangChain 正确解析出一条 `tool_calls`。
Responses 接口也精确返回 `OK`，输入/输出 62/1 tokens，无推理 tokens；实际返回的 `AIMessage.content`
为列表，当前适配器可以解析文本，尚未用 Responses 跑工具循环。
VPS 通过公网 HTTPS 创建会话后，真实聊天返回“连接成功。”；任务读取刚上传的 `source.txt`，
写出并下载 `report.md`，SHA-256 为 `e0b2de65b458c3b9daaf9b9efc4ea8559533f05db69c764c9792f48f7c00f026`，
与源文件完全一致。两服务无重启或 warning 日志；任务完成后分别约占 86 MiB 和 130 MiB，
VPS 可用内存约 255 MiB、swap 使用 0。服务器 Python 的 SQLite 3.45.1 使用 DELETE journal，
符合运行库兼容策略。以上资源数字是验收时快照，后续仍需持续观察。
另建的一次性计划在指定时点后自动产生运行并完成，无需手机持续在线。
同会话快速提交两条聊天输入时，两个回执均为 queued，最终按序返回 A、B；另一次真实文件任务
在 running 状态收到 Steer，服务回执为 accepted，运行事件记录一次 `steer_applied`，
文件列表仅含更正后的 `new.md` 和原始上传文件，没有生成废弃的 `old.md`。
Android 独立模拟器首次上传 TXT 时发现 Expo 会用文件 MIME 覆盖 `application/octet-stream`，
后端正确拒绝了请求；改用原始字节请求体后，原生文件选择与上传回执通过。
这份手机上传文件为 96 字节，云任务产生 94 字节的 `report.md`，两份内容都包含验收词 `Cedar` 和数字 4、7、9。
报告 SHA-256：`099730345e39e1a1e8e5e938305f32b37afcfd9d4bfbcacaeb2f3da29d92a3b8`。
Android 系统分享面板已打开但没有向外部 App 发送；从专用模拟器的 App 缓存取回下载文件，
其 94 字节内容及 SHA-256 与服务器报告完全相同。
在没有在途任务时重启新 API 与 worker 后，`model_ready`、`worker_online` 重新变为 true；
手机会话的已完成运行仍可查，`report.md` 的 94 字节与 SHA-256 保持不变。

## 尚未通过的验收

- **Android 原生联调与真机使用**：2026-09-23 独立模拟器已通过 HTTPS 登录、云聊天和文件上传/生成/下载分享；
  TTS 点击返回中文语音不可用的明确错误，该模拟器未验证播放；正常 JS Reload 后连接与历史已恢复。
  专用模拟器重启后的 App 启动及读回步骤遭自动审批拒绝，故 Android 冷启动恢复与实体设备运行未验收。
- **Mac 部署与迁移**：Mac mini 尚未到货，数据迁移与双机隧道尚未实施。
- **长期运行恢复**：一次性计划、Queue 与 Steer 已在生产触发；新服务正常重启后持久数据可读。
  有在途工具的故障注入与中断恢复仍仅有集成测试验证。
- **Shell、长期记忆整理、推送、外部 harness**：当前未实现，不能用文件工具、checkpoint 或前台刷新替代这些能力。

## 接入真实模型后的使用验收

按[部署说明](DEPLOYMENT.md)连接 myVPS，或按[后端启动说明](../backend/README.md#启动)在本机运行；
按[客户端开发说明](../README.md#本地开发)运行样板房。在手机设置服务地址与令牌后：

1. 保存助手称呼与人格，重开 App 并核对；启动只读环境探索，核对实际工具和目录回执。
2. 上传一份小型文本、PDF 或 DOCX，要求提取内容并生成 Markdown 产物，再下载核对。
3. 执行期间分别提交 Queue 与 Steer，确认目标及应用状态；取消当前任务后确认待处理输入仍在。
4. 另开会话聊天，检查任务状态仍独立；创建一次性计划，离开 App 后检查服务器按时完成。
5. 在无文件工具在途时重启后端，核对历史、计划与队列；中断运行不应被静默重放。
6. 播放和停止 TTS，检查文件选择、分享和网络断线重试的 Android 实际行为。

第 2 步的文本上传、物理文件工具写入和下载已在 VPS 公网 API 完成；其他步骤仍是待验收项目，
不能由单次服务健康检查代替。

## 2026-09-28 页面轮廓增量验收

五入口导航已在 Android 调试 APK 中启动；首页、生活、AI、工作和工具箱均在可见模拟器逐页检查，底部切换正常。首页默认进入；生活财务与工具箱资源库不显示虚构数据。未连接时直接进入五入口，AI 页提供连接表单，没有预览模式。已有对话、计划与设置的真实后端联调沿用上方 2026-09-23 的验收记录，本轮没有重新执行服务端实调。

本轮 `npm run typecheck`、`npm run lint`、`npm run test:mobile`（9 项）、Android / iOS JS bundle 均通过；Android x86_64 原生调试构建及模拟器安装通过。首次构建发现本机默认 NDK 27.1 目录不完整，改用已安装的 NDK 28.2 后通过；调整只发生在忽略的 Expo 生成目录中，未改仓库依赖或系统 SDK。

## 2026-09-28 子智能体增量验收

SQLite v1→v3 迁移测试保留旧会话，固定财务助手自动创建；HTTP 测试覆盖自建助手增删改查、服务工具边界、会话绑定、忙碌时拒绝删除及财务金额观察值的读写。真实 Deep Agents 图测试覆盖主知行委派固定助手、财务助手直接对话时只获得财务专用工具，并通过工具将明确金额写入 SQLite。`uv run pytest -q` 通过 92 项，`uv run ruff check .` 通过。手机 `typecheck`、`lint`、9 项移动端测试与 Android/iOS JS bundle 通过。测试模型未证明云模型已完成财务助手实聊；截图识别、真实账户读取、自动对账和统一资源库仍未接入。

用户提供的蓝底白字图标已用于 App、Android adaptive icon 和 Web favicon。2026-09-28 在可见 Android 模拟器安装本机独立 APK 并查看首页与生活页：图标显示正确，页面无“退出预览”、开发刷新条或模块错误。`expo-doctor` 21/21 通过。本机独立构建用于界面验收，不是正式发行制品；当前模拟器尚未连接新版后端，真实云模型委派仍待联调。
