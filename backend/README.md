# 个人助手后端

2026-09-23：已实现首条会话、持久任务、资料读取与文件交付链路，并在 myVPS 使用百炼新加坡 `qwen3.8-flash` 完成真实聊天及文件任务验收。单用户、单活动主机，
API 与 worker 为独立进程；不需要 PostgreSQL、Redis 或独立队列服务。手机端是可更换布局的功能样板房。

2026-09-29：新增图片附件、原始资源库、Docker 执行、Playwright 浏览器、产物校验与手机交付。本次升级已在 macOS Docker Engine 完成本地集成验收；这不改变上述历史生产验收范围。启用和迁移见[通用执行能力升级](../docs/HARNESS-UPGRADE.md)。

## 启动

需要 uv；仓库通过 `.python-version` 选择已验收的 Python 3.12。依赖由 `uv.lock` 锁定。

```powershell
cd backend
uv sync --locked
Copy-Item config.example.toml config.local.toml
$env:ZHIXING_CONFIG = (Resolve-Path config.local.toml).Path
```

编辑本机的 `config.local.toml`，将 `YOUR_GEMINI_MODEL_ID` 替换为账号可用的模型 ID。
示例先让聊天与执行共用一个 Gemini 配置；可以将 `roles.chat` 和 `roles.task` 分别指向不同模型。
myVPS 使用 [百炼新加坡示例](config.bailian.example.toml)，两个角色目前都指向 `qwen3.8-flash`；
服务进程从环境变量 `ZHIXING_BAILIAN_API_KEY` 读取密钥，配置文件只保存环境变量名。
`chat_completions`、`responses`、`gemini` 三种协议均有接入，配置 `base_url` 可使用对应兼容端点。
可在每个 `[models.*]` 中设置 `provider`、`display_name` 和实际支持的 `reasoning_levels`，供手机端展示与选择；未声明档位时不提供思考深度按钮。供应商地址和密钥仍由服务器配置，模型目录接口不返回它们。手机可更改聊天、执行、记忆整理的默认模型，并给主知行的单段对话选择聊天模型与思考档位，或为单条任务选择模型与思考档位；这些选择持久化在 SQLite，已入队任务保持原模型快照。新增模型或更改连接仍需修改服务端 TOML 并重启 API 与 worker。
记忆整理会在成功对话后由 worker 增量执行。若未配置专用记忆模型，先使用当前聊天默认模型；配置了 `memory` 角色后自动使用该模型。整理失败不把已经完成的聊天改成失败，可由 `/v1/memories/status` 查看并在排除模型故障后调用 `/v1/memories/retry` 重试。

在运行服务的进程环境里设置 `ZHIXING_API_TOKEN`（至少 24 字符的随机服务令牌）与
`ZHIXING_GEMINI_API_KEY`。模型配置只保存环境变量名称；不要把密钥提交到仓库或填入手机模型设置。
然后启动本机 API 和 worker：

```powershell
uv run python -m zhixing_next
```

API 默认监听 `127.0.0.1:8000`，`Ctrl+C` 停止两个进程。只运行一个 worker，重复实例会拒绝启动。
需要独立管理进程时分别运行：

```powershell
uv run uvicorn zhixing_next.api:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
uv run python -m zhixing_next.worker
```

`GET /healthz` 可用于存活检查。产品接口需要 `Authorization: Bearer <服务令牌>`。
未配置模型时仍可管理人格、会话和计划，执行请求会给出配置缺失状态，不返回模拟回答。
`model_ready` 表示聊天和执行模型配置齐全，且所引用的环境变量去除空白后非空；不代表供应商端点已通过真实调用验收。

修改 `config.local.toml` 或模型密钥环境变量后，需要重启 API 与 worker；使用上述联合启动方式时，
先按 `Ctrl+C` 停止，再在已更新环境变量的终端重新运行 `uv run python -m zhixing_next`。
已经标为 `failed` 的运行不会自动重放。检查失败原因及工具回执后，在会话中明确继续队列，
让尚未开始的输入继续执行；若需要重做失败的请求，重新发送要求。“继续队列”不会重试原失败运行。

Android 模拟器在开发模式使用 `http://10.0.2.2:8000`；实体设备使用经过认证的 HTTPS 服务入口。
手机只保存服务 URL 与访问令牌，模型密钥留在后端。Linux 常驻服务、HTTPS 反代和恢复步骤见
[部署与恢复](../docs/DEPLOYMENT.md)；仓库提供 systemd 与 Nginx 模板，实际上线状态以部署验收回执为准。

## 已实现行为

- 单助手人格、项目工作目录、多会话；聊天和任务各有一个并发槽位，同会话严格按 Queue 顺序推进。
- SQLite 保存固定财务助手和可增删的自建助手配置；每段子智能体会话持久绑定其身份，主知行可通过 Deep Agents `task` 委派已配置助手。自建助手只获取选定的物理文件/图片/公开网页工具；财务助手可通过视觉模型读取截图中清晰可见的金额并记录，不能读取真实账户。生活页显示每个平台最新余额观察值和最近收支，不合计总资产或推断扣款链路。
- Queue 网络重试沿用消息 ID；Steer 绑定 running 运行，在真实模型/工具边界介入，checkpoint 持久后标记应用。
- 撤回 queued 输入只取消该输入；取消 running 运行暂停其后续队列，用户明确继续后再推进。
- 消息、事件、运行、计划落在 `app.sqlite`；LangGraph 原生消息与协议元数据落在 `checkpoints.sqlite`。
- 个人语义记忆单独保存在 `app.sqlite`。成功运行的用户输入按顺序增量整理；明确的“记住/纠正/忘记”优先处理。新对话只带入少量相关记忆，主知行可按需调用只读 `browse_personal_memories` 工具查看更多；服务中的当前数据优先于旧记忆。后端提供认证后的记忆读写和失败重试接口，手机端暂不展示记忆列表。纠正或遗忘会重置来源会话和实际读过该记忆的会话的模型上下文，其他会话不受影响；原聊天记录不删除。
- 服务重启保留排队输入。上次 running 状态变为 interrupted 并暂停该会话，保留工具回执；
  检查结果后继续队列或发送新要求，不自动重放可能已写文件的步骤。
- 定时计划支持一次性与固定间隔，UTC 保存，手机用本地时间输入。重复时点去重，错过多次合并一次，
  同一计划尚有未完成运行时不重叠；暂停和继续均持久化。
- 主知行可通过工具创建、查看和暂停上述计划；聊天可自动发起同会话后台执行任务，无须用户手动切换模式。后台执行沿用任务模型、附件和搜索服务，仍受已有队列、取消和阻塞语义约束。
- 项目目录之外的文件通过服务配置 `[[grants]]` 授权只读/可写。运行时不根据模型要求自行扩大权限。
- 文件上传/下载最大 20 MiB，文本读写最大 256 KiB；PDF/DOCX 提取最大 10 MiB，输出分页并限长。
  文本提取工具不做 OCR；DOCX 只提取正文文本。启用执行后可用 LibreOffice/Poppler 渲染，再由视觉模型查看扫描件或排版。上传成功不等于所有格式都可以解析。
- 给定公开 HTTPS URL 可以提取网页正文、来源和获取时间；有大小、总时限、重定向与地址限制。
  该网页读取工具不执行页面 JavaScript，也不访问私网；目前直接连接，不继承系统代理。
- 主知行的单条聊天或任务可按需启用 Brave、Tavily 或 Serper 联网搜索。手机端添加服务时提交 API 密钥，密钥只保存在服务端 app.sqlite，不返回手机、不进入模型上下文；未启用的运行没有搜索工具。搜索账号、额度与真实连通性需配置后验收；自动测试只验证协议与工具链路。备份数据库时按凭据处理。
- 手机支持上传资料、查看工作文件、下载分享产物与手动 TTS。
- 图片以持久附件进入聊天与财务页，支持仅发图片、Queue/Steer、断线重试和历史预览。模型需声明 `image_input = true`；图片最大 2400 万像素，每条最多 8 份资料。原件保存在 `data_dir/resources`，模型使用最长边 2048 的 JPEG 预览，编辑工作副本不会改变原图。工具箱资源库可分页查看、筛选已加载名称和下载分享。
- 显式启用 `[execution]` 后，主知行任务使用 Deep Agents Docker backend 执行 Python、Node、Shell；内置文档、表格、研究技能。`browser_action` 用实际 Chromium 执行页面交互和下载；`publish_artifact` 重新读取并校验文件，再将不可变产物附在助手回复中。
- 手机工具箱可查看按供应商分组的模型并选择角色默认值；主知行欢迎页和对话输入区可搜索/收藏模型，为聊天或任务选择模型与已声明的思考档位、配置并开启联网搜索、上传文件。生活页的财务助手在财务子页面简约对话，仍绑定原有财务工具与会话。

## 数据与权限边界

默认数据目录 `backend/.data`，默认项目/会话文件在其 `workspaces` 子目录。
`workspace_root` 不能等于或包含服务数据目录。不要将 `.data`、配置文件、数据库或服务凭据作为普通资料目录开放。
文件工具拒绝目录穿越、敏感文件、符号链接、Windows junction/重解析点及硬链接；POSIX 文件访问使用目录描述符。
Windows 校验适用于可信单用户主机，不声称能隔离恶意本机进程。

Shell 默认关闭，启用后只在每任务独立的 Linux 容器中执行；不退回宿主 Shell。容器仅挂载该项目/会话的 `/workspace`，没有模型密钥、服务数据库或 Docker socket。只读根目录、非 root 用户、资源限制与默认断网共同约束执行。`network = "bridge"` 是对 Docker 可达网络的整体授权，包含可能可达的内网，并不是仅允许公网；简单网页读取工具原有的公网限制不适用于该配置。额外 `grants` 仍经文件工具访问，主知行可用 `copy_file` 导入/导出，不会自动挂进容器。取消/超时移除整个容器，worker 重启先清理其拥有的旧容器，再标记运行中断。

普通聊天及直接子智能体会话仍使用 Deep Agents 虚拟临时文件系统，主知行后台执行的工作文件才与 App 文件列表共享。项目内多会话共享文件。记忆目前整理聊天中得到的用户事实，不自动遍历笔记、文件或图片，也没有语义索引；尚未实现外部 harness 编排、推送、宿主服务管理或手机执行环境。具体网络、存储与验收边界见[升级说明](../docs/HARNESS-UPGRADE.md)。

SQLite 使用短事务、外键校验与 `synchronous=FULL`。包含 WAL-reset 修复的运行库使用 WAL，
较旧运行库使用 DELETE journal；checkpointer 连接也强制同一规则，SDK 初始化不能覆盖它。
这是运行库兼容处理，不会替换用户的全局 Python 或 SQLite DLL。版本依据见 [SQLite 官方说明](https://sqlite.org/wal.html)。
所有数据库都在同一主机的本地磁盘，不能在 Mac 与 VPS 间共享网络文件写入。

备份时停止接收新任务及 worker，确认没有文件工具或执行容器在途，再一致性备份数据库、`resources` 原件与工作文件。
不得只复制活动的 `.sqlite` 而遗漏日志文件。迁往 Mac 时整体迁移并验证恢复，始终只有一个活动 worker。

## 验证

```powershell
uv run pytest -q
uv run ruff check .
```

测试覆盖真实 SQLite、多会话 Deep Agents 图、持久 checkpoint、模型协议配置与元数据续接、
Queue/Steer/取消竞态、调度去重、进程所有权、文件越权与 API→worker→文件回传。
测试模型与 HTTP transport 只注入测试，不属于产品运行模式；百炼新加坡与 myVPS 公网部署的实际验收见
[验收记录](../docs/VERIFICATION.md)。新增 Docker 集成回归需先构建镜像，然后运行 `ZHIXING_TEST_DOCKER=1 uv run pytest -q`；未设置此变量时相关测试明确跳过，不能据普通 pytest 通过声称 Shell 已验收。本次真实容器测试及文档渲染结果见[升级说明](../docs/HARNESS-UPGRADE.md)。
HTTP 契约见 [API.md](../docs/API.md)，长期架构目标见 [ARCHITECTURE.md](../docs/ARCHITECTURE.md)。
