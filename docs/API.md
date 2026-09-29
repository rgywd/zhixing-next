# 首条实现链路与接口契约

状态：2026-09-28，后端记忆链路已加入本地实现。实际运行能力与限制见[后端说明](../backend/README.md)。

## 交付范围

Python FastAPI + SQLite，API 与 worker 独立进程；React Native 客户端连接真实后端。
已实现会话、人格、项目、子智能体、消息 Queue/Steer、取消、进度查询、持久计划、Deep Agents 模型/文件工具及轻量个人记忆。
文件/图片的自动记忆提取、外部 harness 与推送通知留作后续。模型未配置时明确失败，不返回模拟助手回复。

## 公共约定

接口前缀 `/v1`；除 `/healthz` 外均需要 `Authorization: Bearer <服务访问令牌>`。
JSON 字段使用 snake_case，时间为 UTC ISO 8601；列表 `{items: [], next_cursor: null|string}`。
错误 `{error: {code: string, message: string}}`。请求 ID/消息 ID 由客户端生成；重试相同 ID 与相同内容返回原记录，
相同 ID 不同内容返回 409。限长与枚举由入口校验；列表默认 50，最大 100。
用户和模型供应商密钥分离；App 只持有服务访问令牌。

## HTTP 接口

- `GET /v1/status`: `{model_ready: bool, worker_online: bool, execution_available: bool}`，可增加说明字段；`model_ready` 按当前聊天/执行默认模型及服务端密钥判断，不代表供应商已通过调用。
- `GET /v1/models`：返回 `{items,roles}`。每个模型只公开 `id,name,model,provider,protocol,ready,reasoning_levels,default_reasoning_effort`；不返回密钥、环境变量名或 Base URL。`roles` 为聊天、执行、记忆整理的当前默认模型 ID。
- `PUT /v1/models/roles/{role} {model_id}`：`role` 为 `chat|task|memory`，保存角色默认模型。模型须已在服务端配置；未配置专用记忆模型时，整理使用当前聊天默认模型。
- `GET /v1/memories?cursor=&limit=`：返回个人语义记忆 `{items,next_cursor}`；每项含 `id,content,source_message_id,created_at,updated_at,seq`。只读当前记忆，不返回原始聊天或内部去重键。
- `POST /v1/memories {content}`、`PATCH /v1/memories/{id} {content}`、`DELETE /v1/memories/{id}`：后端直接写入、纠正或忘记；内容最多 500 字，凭据类内容拒绝写入。删除记忆不删除原会话或文件。
- `GET /v1/memories/status`：返回 `{pending,failed}` 整理运行数；`POST /v1/memories/retry` 将失败的整理重新排队，返回 `{retried}`。手机端暂不展示记忆列表，整理状态仍由后台处理。
- `GET /v1/search/providers`：列出已配置搜索服务 `{items:[{id,name,kind}],next_cursor:null}`，不返回密钥。`POST /v1/search/providers {name,kind:brave|tavily|serper,api_key}` 在服务端保存密钥并返回 `{id,name,kind}`；`DELETE /v1/search/providers/{id}` 删除服务，若排队或运行中的消息正在引用则返回 409。
- `GET /v1/assistant`, `PUT /v1/assistant`: `{name, persona}`，人格是用户编辑的持久文本。
- `GET /v1/agents`, `POST /v1/agents`, `GET/PUT/DELETE /v1/agents/{id}`：子智能体配置
  `{id,kind: service|custom,service: string|null,name,description,instructions,tools: string[],visible,created_at,updated_at}`。
  创建/修改输入 `{name,description,instructions,tools,visible}`；固定服务助手不可删除，且工具由服务固定。删除自建助手前需完成其排队或运行中的任务；旧会话保留并转为主知行会话。
  自建助手可选工具仅为 `inspect_environment`、`list_directory`、`read_text_file`、`read_document`、`write_text_file`、`fetch_public_page`；服务器的目录授权仍生效。
- `GET /v1/finance/observations`：`{balances: FinanceObservation[],recent: FinanceObservation[]}`。固定财务助手专用工具可记录/列出/删除用户明确提供的 CNY 金额观察值；`balance` 为各平台最后一次观察，`income`/`expense` 取最近 20 条。记录包含 `id,kind,platform,amount,note,conversation_id,created_at`。这不是实时账户查询或自动对账接口。
- `GET /v1/projects`, `POST /v1/projects {name}`: 项目 `{id,name,workspace_path,created_at}`；路径由服务器创建。
- `GET /v1/conversations`, `POST /v1/conversations {title,project_id?: string|null,agent_id?: string|null}`:
  会话 `{id,title,project_id,agent_id,blocked: bool,created_at,updated_at}`；`agent_id=null` 为主知行。
- `GET /v1/conversations/{id}`：单个会话及当前 blocked 状态。
- `PUT /v1/conversations/{id}/model {model_id:string|null,reasoning_effort:auto|none|low|medium|high|xhigh|null}`：主知行与绑定专用助手的会话均可设置聊天模型和思考档位；null 表示继承默认。档位必须在模型声明的 `reasoning_levels` 内。设置只影响之后入队的聊天，已提交的运行保留入队时的模型快照。
- `GET /v1/conversations/{id}/messages?cursor=&limit=`: 按序号升序，消息
  `{id,conversation_id,role: user|assistant,content,intent: queue|steer,run_id,status: accepted|applied|rejected,created_at,seq}`。
- `POST /v1/conversations/{id}/messages {id,content,intent: queue|steer,kind: chat|task,target_run_id?: string,model_id?: string,reasoning_effort?: auto|none|low|medium|high|xhigh,search_provider_id?: string}`:
  回执 `{message,run}`；queue 创建 queued 运行，主知行与专用助手均可为单条聊天或任务覆盖模型与思考档位并选择联网搜索服务，保持原会话的助手身份与工具范围（选中的搜索工具仅对该次运行开放）；steer 必须绑定实际 running 运行，不接受这些覆盖字段，也不创建新运行。同一消息 ID 重试必须保持所有字段一致。
- `POST /v1/conversations/{id}/resume`: 清除失败/取消后的队列阻塞，允许尚未开始的排队消息继续。
- `GET /v1/runs?conversation_id=&cursor=&limit=`: 运行列表；`GET /v1/runs/{id}`: 单个运行。
  运行 `{id,conversation_id,message_id,kind: chat|task,model_id,reasoning_effort,search_provider_id,status: queued|running|completed|failed|cancelled|interrupted,
  prompt,cancel_requested: bool,result: string|null,error: string|null,created_at,started_at,finished_at,memory_processed: -1|0|1}`。
  `memory_processed` 为 0 待整理、1 已处理、-1 整理失败；聊天结果完成与记忆整理状态分离。
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
memory.py 在成功运行后整理用户确认的持久事实；整理按运行顺序进行，增删改与处理标记在同一 SQLite 事务提交。运行时只带入少量相关记录，checkpoint 不充当长期记忆。

配置由 `config.py` 提供 `Settings`、`ModelConfig`、`PathGrant` 和 `load_settings()`：
Settings: data_dir: Path, workspace_root: Path, api_token: str, models: dict[str,ModelConfig],
roles: dict[str,str], grants: list[PathGrant], poll_interval: float=0.25。
ModelConfig: protocol: chat_completions|responses|gemini, model: str, api_key_env: str,
provider/display_name: str|None, reasoning_levels: list, base_url: str|None,
temperature: float|None, timeout: float=60。服务端配置定义可选模型和供应商；角色默认值与主会话选择保存在 SQLite。
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
模型 ID、思考档位和搜索服务 ID 在消息入队时写入运行记录，worker 按快照调用；LangGraph thread 以 conversation_id 标识，checkpoint 使用 data_dir 下独立 SQLite。worker 在运行开始时读取子智能体配置快照；主知行只委派已配置命名助手，直接子智能体会话只获得自己的工具。搜索密钥只存服务端 SQLite，不进入消息、运行记录或 API 回执；联网结果是外部资料，回答应引用来源链接。
初版崩溃中的运行标记 interrupted；用户清除阻塞后可发送新要求，不宣称任意工具能自动安全续跑。
