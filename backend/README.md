# 个人助手后端

2026-09-22：已实现首条会话、持久任务、资料读取与文件交付链路。单用户、单活动主机，
API 与 worker 为独立进程；不需要 PostgreSQL、Redis 或独立队列服务。手机端是可更换布局的功能样板房。

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
`chat_completions`、`responses`、`gemini` 三种协议均有接入，配置 `base_url` 可使用对应兼容端点。
记忆整理角色尚未运行，不需要为它配置密钥。

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
手机只保存服务 URL 与访问令牌，模型密钥留在后端。此仓库未配置公网代理、系统服务或生产部署。

## 已实现行为

- 单助手人格、项目工作目录、多会话；聊天和任务各有一个并发槽位，同会话严格按 Queue 顺序推进。
- Queue 网络重试沿用消息 ID；Steer 绑定 running 运行，在真实模型/工具边界介入，checkpoint 持久后标记应用。
- 撤回 queued 输入只取消该输入；取消 running 运行暂停其后续队列，用户明确继续后再推进。
- 消息、事件、运行、计划落在 `app.sqlite`；LangGraph 原生消息与协议元数据落在 `checkpoints.sqlite`。
- 服务重启保留排队输入。上次 running 状态变为 interrupted 并暂停该会话，保留工具回执；
  检查结果后继续队列或发送新要求，不自动重放可能已写文件的步骤。
- 定时计划支持一次性与固定间隔，UTC 保存，手机用本地时间输入。重复时点去重，错过多次合并一次，
  同一计划尚有未完成运行时不重叠；暂停和继续均持久化。
- 项目目录之外的文件通过服务配置 `[[grants]]` 授权只读/可写。运行时不根据模型要求自行扩大权限。
- 文件上传/下载最大 20 MiB，文本读写最大 256 KiB；PDF/DOCX 提取最大 10 MiB，输出分页并限长。
  PDF 扫描件没有 OCR；DOCX 只提取正文文本，不保留排版。上传成功不等于所有格式都可以解析。
- 给定公开 HTTPS URL 可以提取网页正文、来源和获取时间；有大小、总时限、重定向与地址限制。
  该工具不提供搜索引擎、不执行页面 JavaScript，也不访问私网；目前直接连接，不继承系统代理。
- 手机支持上传资料、查看工作文件、下载分享产物与手动 TTS。

## 数据与权限边界

默认数据目录 `backend/.data`，默认项目/会话文件在其 `workspaces` 子目录。
`workspace_root` 不能等于或包含服务数据目录。不要将 `.data`、配置文件、数据库或服务凭据作为普通资料目录开放。
文件工具拒绝目录穿越、敏感文件、符号链接、Windows junction/重解析点及硬链接；POSIX 文件访问使用目录描述符。
Windows 校验适用于可信单用户主机，不声称能隔离恶意本机进程。

**当前没有 Shell 执行能力。** 文件工具是真实的受限文件操作，不是 OS 代码沙盒。
Linux/macOS 命令沙盒需要在目标主机单独接入与验收；不会退回裸 Shell。Deep Agents 虚拟文件仅供临时推理，
只有物理文件工具写入的内容才会出现在 App 文件列表。尚未实现外部 harness 编排、自动记忆整理、推送或手机执行环境。

SQLite 使用短事务、外键校验与 `synchronous=FULL`。包含 WAL-reset 修复的运行库使用 WAL，
较旧运行库使用 DELETE journal；checkpointer 连接也强制同一规则，SDK 初始化不能覆盖它。
这是运行库兼容处理，不会替换用户的全局 Python 或 SQLite DLL。版本依据见 [SQLite 官方说明](https://sqlite.org/wal.html)。
所有数据库都在同一主机的本地磁盘，不能在 Mac 与 VPS 间共享网络文件写入。

备份时停止接收新任务及 worker，确认没有文件工具在途，再一致性备份数据库与工作文件。
不得只复制活动的 `.sqlite` 而遗漏日志文件。迁往 Mac 时整体迁移并验证恢复，始终只有一个活动 worker。

## 验证

```powershell
uv run pytest -q
uv run ruff check .
```

测试覆盖真实 SQLite、多会话 Deep Agents 图、持久 checkpoint、模型协议配置与元数据续接、
Queue/Steer/取消竞态、调度去重、进程所有权、文件越权与 API→worker→文件回传。
测试模型与 HTTP transport 只注入测试，不属于产品运行模式；真实云模型、Linux/macOS Shell 与公网部署需独立验收。
HTTP 契约见 [API.md](../docs/API.md)，长期架构目标见 [ARCHITECTURE.md](../docs/ARCHITECTURE.md)。
