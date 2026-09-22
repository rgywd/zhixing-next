# 首条实现链路与接口契约

状态：2026-09-22，首条实现链路。实际能力与限制见[后端说明](../backend/README.md)。

## 交付范围

Python FastAPI + SQLite，API 与 worker 独立进程；React Native 客户端连接真实后端。
本轮实现会话、人格、项目、消息 Queue/Steer、取消、进度查询、持久计划及 Deep Agents 模型/文件工具。
完整记忆整理、外部 harness、推送通知与生产部署留作后续。模型未配置时明确失败，不返回模拟助手回复。

## 公共约定

接口前缀 `/v1`；除 `/healthz` 外均需要 `Authorization: Bearer <服务访问令牌>`。
JSON 字段使用 snake_case，时间为 UTC ISO 8601；列表 `{items: [], next_cursor: null|string}`。
错误 `{error: {code: string, message: string}}`。请求 ID/消息 ID 由客户端生成；重试相同 ID 与相同内容返回原记录，
相同 ID 不同内容返回 409。限长与枚举由入口校验；列表默认 50，最大 100。
用户和模型供应商密钥分离；App 只持有服务访问令牌。

## HTTP 接口

- `GET /v1/status`: `{model_ready: bool, worker_online: bool, execution_available: bool}`，可增加说明字段。
- `GET /v1/assistant`, `PUT /v1/assistant`: `{name, persona}`，人格是用户编辑的持久文本。
- `GET /v1/projects`, `POST /v1/projects {name}`: 项目 `{id,name,workspace_path,created_at}`；路径由服务器创建。
- `GET /v1/conversations`, `POST /v1/conversations {title,project_id?: string|null}`:
  会话 `{id,title,project_id,blocked: bool,created_at,updated_at}`。
- `GET /v1/conversations/{id}`：单个会话及当前 blocked 状态。
- `GET /v1/conversations/{id}/messages?cursor=&limit=`: 按序号升序，消息
  `{id,conversation_id,role: user|assistant,content,intent: queue|steer,run_id,status: accepted|applied|rejected,created_at,seq}`。
- `POST /v1/conversations/{id}/messages {id,content,intent: queue|steer,kind: chat|task,target_run_id?: string}`:
  回执 `{message,run}`；queue 创建 queued 运行；steer 必须绑定实际 running 运行并原子检查，不创建新运行。
- `POST /v1/conversations/{id}/resume`: 清除失败/取消后的队列阻塞，允许尚未开始的排队消息继续。
- `GET /v1/runs?conversation_id=&cursor=&limit=`: 运行列表；`GET /v1/runs/{id}`: 单个运行。
  运行 `{id,conversation_id,message_id,kind: chat|task,status: queued|running|completed|failed|cancelled|interrupted,
  prompt,cancel_requested: bool,result: string|null,error: string|null,created_at,started_at,finished_at}`。
- `POST /v1/runs/{id}/cancel`: queued 立即撤回，不改变会话阻塞状态；running 持久记录取消请求，
  实际停止后暂停其后续队列。取消不删除后续队列。
- `GET /v1/runs/{id}/events?after=0&limit=100`: `{items: [{seq,run_id,type,data,created_at}],next_cursor}`。
  类型包括 started/progress/tool/steer_applied/completed/failed/cancelled/interrupted；序号单调递增。
- `GET /v1/schedules`, `POST /v1/schedules {id,conversation_id,prompt,next_run_at,interval_seconds?: number|null}`:
  计划 `{id,conversation_id,prompt,next_run_at,interval_seconds,enabled,last_run_id,created_at}`。
  一次性时间和固定间隔；UTC 存储，客户端转换当地时间。相同计划未完成时不重叠，多次错过合并一次。
- `PATCH /v1/schedules/{id} {enabled}`: 暂停/启用，启用时补跑规则同上。

会话、消息和运行列表支持 `latest=true` 取最新窗口，返回条目仍按 seq 升序，并附 `previous_cursor`；
使用 `before=<seq>` 读取更早窗口。`cursor` 向后补齐与 latest/before 互斥。运行列表另支持 `status` 筛选。
消息状态可能在旧 seq 上更新，客户端需要刷新当前运行对应的消息回执，不只追加新 seq。

## 文件传输

- `GET /v1/conversations/{id}/files`：`{items:[{path,name,size}],next_cursor:null,truncated}`，
  只列出会话工作目录，最多扫描 200 个目录并返回 200 个常规文件，超出时明确 truncated。
- `PUT /v1/conversations/{id}/files/{file_id}?filename=...`：原始二进制 body，最大 20 MiB，file_id 为 UUID。
  文件写入 `uploads/<file_id>/<filename>`，回执 `{path,name,size}`；相同 ID/name/content 重试返回原文件，冲突返回 409。
- `GET /v1/conversations/{id}/files/content?path=...`：认证后下载工作目录内相对路径，最大 20 MiB。

文件接口均需要服务令牌，拒绝目录穿越、链接和受保护文件；额外执行目录授权不扩大手机文件下载范围。

## 内部运行契约

代码在 `backend/src/zhixing_next`。config.py 负责配置，store.py 负责业务事务，api.py 负责 HTTP，
worker.py 负责调度与生命周期，runtime.py/models.py/tools.py 负责实际智能体与工具调用。

配置由 `config.py` 提供 `Settings`、`ModelConfig`、`PathGrant` 和 `load_settings()`：
Settings: data_dir: Path, workspace_root: Path, api_token: str, models: dict[str,ModelConfig],
roles: dict[str,str], grants: list[PathGrant], poll_interval: float=0.25。
ModelConfig: protocol: chat_completions|responses|gemini, model: str, api_key_env: str,
base_url: str|None, temperature: float|None, timeout: float=60。
PathGrant: path: Path, writable: bool=False。服务端 TOML 配置引用环境变量，不将密钥写入 TOML。

Store(settings) 的 worker 接口（同步短事务，每次调用独立连接）：
- claim_next(kind) -> run dict|None：领取会话未阻塞、无 running 运行的首条 queued，返回包含 project workspace_path 的运行。
- get_run(run_id) -> dict；get_assistant() -> dict；get_controls(run_id) -> `{cancel_requested,steers:[message dict]}`。
- acknowledge_steers(run_id, ids) -> None；add_event(run_id, type, data) -> None。
- finish_run(run_id, status, result=None, error=None) -> None：终态+助手结果消息+事件原子写入；失败/取消/中断阻塞该会话队列。
- recover_interrupted() -> None：旧 running 标 interrupted 并保留回执；不自动重放副作用。
- tick_schedules() -> None：触发唯一性、创建输入/运行、推进时间在一个事务内完成。
- heartbeat() -> None；worker_online() -> bool。初始化幂等；单 worker 实例由根实现进程锁。

运行时接口 `async run_agent(settings, run, *, persona, emit, controls, acknowledge) -> str`：
emit(type, data)、controls()、acknowledge(ids) 均为异步回调。取消可通过 asyncio task cancellation 打断，
模型与工具步边界检查 controls；steer 使用稳定消息 ID 注入真实模型上下文，checkpoint 落盘后才 acknowledge。
模型配置由 run.kind 对应 role 选择；LangGraph thread 以 conversation_id 标识，checkpoint 使用 data_dir 下独立 SQLite。
初版崩溃中的运行标记 interrupted；用户清除阻塞后可发送新要求，不宣称任意工具能自动安全续跑。
