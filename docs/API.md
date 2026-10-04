# 首条实现链路与接口契约

状态：2026-09-29，已加入资源附件、视觉输入和隔离执行。实际运行能力与限制见[后端说明](../backend/README.md)。

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

- `GET /v1/status`: `{model_ready: bool, worker_online: bool, execution_available: bool, execution_reason: string|null, file_tools_available: bool}`；`model_ready` 按当前聊天/执行默认模型及服务端密钥判断，不代表供应商已通过调用。`execution_available` 检查启用配置及 Docker 镜像可见性，实际启动仍可能失败，以执行回执为准。
- `GET /v1/models`：返回 `{items,roles}`。每个模型只公开 `id,name,model,provider,protocol,ready,image_input,reasoning_levels,default_reasoning_effort,reasoning_kind,reasoning_labels`；`image_input` 是服务端对端点能力的声明，不是实时探测。不返回密钥、环境变量名或 Base URL。`roles` 为聊天、执行、记忆整理的当前默认模型 ID。
- `PUT /v1/models/roles/{role} {model_id}`：`role` 为 `chat|task|memory`，保存角色默认模型。模型须已在服务端配置；未配置专用记忆模型时，整理使用当前聊天默认模型。
- `GET /v1/memories?cursor=&limit=`：返回个人语义记忆 `{items,next_cursor}`；每项含 `id,content,source_message_id,created_at,updated_at,seq`。只读当前记忆，不返回原始聊天或内部去重键。
- `POST /v1/memories {content}`、`PATCH /v1/memories/{id} {content}`、`DELETE /v1/memories/{id}`：后端直接写入、纠正或忘记；内容最多 500 字，凭据类内容拒绝写入。删除记忆不删除原会话或文件。
- `GET /v1/memories/status`：返回 `{pending,failed}` 整理运行数；`POST /v1/memories/retry` 将失败的整理重新排队，返回 `{retried}`。手机侧栏可以查看和忘记记忆，整理状态仍由后台处理。
- `GET /v1/conversations/recent?limit=10`：按 `updated_at` 降序取最近活动会话，覆盖较早建立的话题；不是创建序号窗口。
- `GET /v1/conversations?project_id=<id>`：在分页前按项目过滤，支持现有 `cursor`、`latest`、`before` 语义；无此项目返回 404。
- `GET /v1/conversations/search?q=&sort=relevance|newest|oldest&limit=`：认证后搜索全部会话标题和未拒绝消息正文，空格分词取交集，支持中文、部分词和字面量 `%`、`_`。最多返回 100 项 `{items:[{conversation_id,title,agent_id,updated_at,message_id,message_seq,snippet}]}`；标题命中优先于正文命中，同级按更新时间排序。当前单用户 SQLite 直接检索，历史量增长后可再引入全文索引。
- `GET /v1/search/providers`：列出已配置搜索服务 `{items:[{id,name,kind}],next_cursor:null}`，不返回密钥。`POST /v1/search/providers {name,kind:brave|tavily|serper,api_key}` 在服务端保存密钥并返回 `{id,name,kind}`；`DELETE /v1/search/providers/{id}` 删除服务，若排队或运行中的消息正在引用则返回 409。
- `GET /v1/assistant`, `PUT /v1/assistant`: `{name, persona}`，人格是用户编辑的持久文本。
- `GET /v1/agents`, `POST /v1/agents`, `GET/PUT/DELETE /v1/agents/{id}`：子智能体配置
  `{id,kind: service|custom,service: string|null,name,description,instructions,tools: string[],visible,created_at,updated_at}`。
  创建/修改输入 `{name,description,instructions,tools,visible}`；固定服务助手不可删除，且工具由服务固定。删除自建助手前需完成其排队或运行中的任务；旧会话保留并转为主知行会话。
  自建助手可选工具仅为 `inspect_environment`、`list_directory`、`read_text_file`、`read_document`、`view_image`、`write_text_file`、`fetch_public_page`；服务器的目录授权仍生效。实际模型未开启图片输入时不提供 `view_image`。
- `GET /v1/finance/observations`：`{balances: FinanceObservation[],recent: FinanceObservation[]}`。固定财务助手专用工具可记录/列出/删除用户明确提供的 CNY 金额观察值；`balance` 为各平台最后一次观察，`income`/`expense` 取最近 20 条。记录包含 `id,kind,platform,amount,note,conversation_id,created_at`。这不是实时账户查询或自动对账接口。
- `GET /v1/projects/{id}`：读取指定项目；不存在返回 404。
- `GET /v1/projects`, `POST /v1/projects {name}`: 项目 `{id,name,workspace_path,created_at}`；路径由服务器创建。
- `GET /v1/conversations`, `POST /v1/conversations {title,project_id?: string|null,agent_id?: string|null}`:
  会话 `{id,title,project_id,agent_id,blocked: bool,created_at,updated_at}`；`agent_id=null` 为主知行。
- `GET /v1/conversations/{id}`：单个会话及当前 blocked 状态。
- `PUT /v1/conversations/{id}/model {model_id:string|null,reasoning_effort:auto|none|minimal|low|medium|high|xhigh|max|null}`：主知行与绑定专用助手的会话均可设置聊天模型和思考档位；null 表示继承助手配置或角色默认模型。单次请求模型优先于会话模型，再继承助手配置与角色默认模型。档位必须在模型声明的 `reasoning_levels` 内。设置只影响之后入队的聊天，已提交的运行保留入队时的模型快照。
- `GET /v1/conversations/{id}/messages?cursor=&limit=`: 按序号升序，消息
  `{id,conversation_id,role: user|assistant,content,attachments: Resource[],intent: queue|steer,run_id,status: accepted|applied|rejected,created_at,seq}`。
  自动转交的任务输入额外带 `origin:assistant_task`，手机显示为后台任务，不作为用户事实提取记忆；此字段只由服务端设置。内部转交可汇集多次 Steer 的附件，外部每条消息仍最多 8 份。
- `POST /v1/conversations/{id}/messages {id,content?: string,attachments?: string[],intent: queue|steer,kind: chat|task,target_run_id?: string,model_id?: string,reasoning_effort?: auto|none|minimal|low|medium|high|xhigh|max,search_provider_id?: string}`:
  回执 `{message,run}`；queue 创建 queued 运行，主知行与专用助手均可为单条聊天或任务覆盖模型与思考档位并选择联网搜索服务，保持原会话的助手身份与工具范围（选中的搜索工具仅对该次运行开放）；steer 必须绑定实际 running 运行，不接受这些覆盖字段，也不创建新运行。同一消息 ID 重试必须保持所有字段一致。
  `content` 默认空串，文字和附件至少提供一项；`attachments` 为最多 8 个不重复资源 ID，必须属于当前会话或同项目工作目录。引用越界返回 403，当前模型明确不支持图片返回 422，校验失败不落入队消息。Steer 图片使用目标运行模型校验。旧客户端不传附件仍兼容。
- `POST /v1/conversations/{id}/resume`: 清除失败/取消后的队列阻塞，允许尚未开始的排队消息继续。
- `GET /v1/runs?conversation_id=&cursor=&limit=`: 运行列表；`GET /v1/runs/{id}`: 单个运行。
  运行 `{id,conversation_id,message_id,kind: chat|task,model_id,reasoning_effort,search_provider_id,status: queued|running|completed|failed|cancelled|interrupted,
  prompt,attachments: Resource[],cancel_requested: bool,result: string|null,error: string|null,created_at,started_at,finished_at,memory_processed: -1|0|1}`。
  `memory_processed` 为 0 待整理、1 已处理、-1 整理失败；聊天结果完成与记忆整理状态分离。
- 运行另含 `phase: normal|approval|recovering`、`recovery_enabled: 0|1`、`recovery_count: number`。等待批准使用 `status=queued,phase=approval`，不会被 worker 领取；同会话后续输入不能越过它。
- `POST /v1/runs/{id}/resume`: 重新入队带恢复记录的 interrupted 运行，继续原 run_id 和 checkpoint，返回 Run；不支持取消/失败运行（422），同会话已执行后续任务时返回 409。同一个 queued/recovering 请求可重复提交。
- `POST /v1/runs/{id}/cancel`: 从未开始的 queued 立即撤回，不改变会话阻塞状态；等待批准或恢复的已开始任务取消后阻塞队列；running 持久记录取消请求，
  实际停止后暂停其后续队列。取消不删除后续队列。
- `GET /v1/runs/{id}/events?after=0&limit=100`: `{items: [{seq,run_id,type,data,created_at}],next_cursor}`。
  类型包括 started/progress/tool/steer_applied/execution/artifact/operation/approval/paused/recovering/completed/failed/cancelled/interrupted；序号单调递增。
  `operation.data={id,tool,state}`；`approval.data={id,kind?,status}`；`paused.data={reason:approval|resume}`；`recovering.data` 包含自动恢复的 `attempt` 或手动恢复的 `requested:true`。
  `execution.data` 含 `id,status: started|running|completed|failed|timed_out|cancelled|interrupted`，按阶段提供 `timeout_seconds,output,exit_code,truncated,stopped,reason`。命令输出最多 64 KiB；只有确认容器已停止才返回 `stopped:true`。重启清理使用容器 ID 和 `reason:worker_restart`，普通命令使用独立执行 ID。
  `artifact.data` 为 `{resource:Resource,verification:{format,sha256,checks,visual_checked:false,...}}`。结构检查不代表视觉检查；成功运行的助手消息附带该运行所有已发布产物，失败前已发布的资源仍可在资源库查看。
- `GET /v1/schedules`, `POST /v1/schedules {id,conversation_id,prompt,next_run_at,interval_seconds?: number|null}`:
  计划 `{id,conversation_id,prompt,next_run_at,interval_seconds,enabled,last_run_id,created_at}`。
  一次性时间和固定间隔；UTC 存储，客户端转换当地时间。相同计划未完成时不重叠，多次错过合并一次。
- `PATCH /v1/schedules/{id} {enabled}`: 暂停/启用，启用时补跑规则同上。

会话、消息和运行列表支持 `latest=true` 取最新窗口，返回条目仍按 seq 升序，并附 `previous_cursor`；
使用 `before=<seq>` 读取更早窗口。`cursor` 向后补齐与 latest/before 互斥。运行列表另支持 `status` 筛选。
消息状态可能在旧 seq 上更新，客户端需要刷新当前运行对应的消息回执，不只追加新 seq。

## 操作批准与回执

以下接口均需服务 Bearer 令牌；模型工具不能提交批准或扩大目录权限。

- `GET /v1/approvals?conversation_id=&run_id=`：最多 100 项待决定请求，`{items:Approval[],next_cursor:null}`，参数可组合筛选。
- `POST /v1/approvals/{UUID}/decision {decision}`：返回 Approval。overwrite/network 支持 `approve|deny`，uncertain 支持 `retry|skip`；同决定重试幂等，冲突或已撤销返回 409，不适用的决定返回 422。全部待决定项处理后继续原任务。
- `GET /v1/approvals/{UUID}/file?version=before|after`：overwrite 的原件或完整拟写入文件，默认 after；最大 20 MiB，SHA-256 校验、nosniff、private/no-store。没有文件预览返回 422。
- `GET /v1/runs/{id}/operations`：`{items:Operation[],next_cursor:null}`，用于核查操作状态；不返回完整工具结果编码。

`Approval={id,run_id,operation_id:string|null,kind:overwrite|network|uncertain,details,state:pending|approve|deny|retry|skip|cancelled,created_at,decided_at}`。
details 包含 title；overwrite 含 path、before_sha256、after_sha256、bytes、backup、最多 4000 字符 preview；network 含 description、task、network；uncertain 含 description、tool、arguments。
`Operation={id,run_id,call_id,tool,plan,state:prepared|started|succeeded|failed|denied|unconfirmed,created_at,updated_at}`。文件 plan 保存前后校验、大小、目标、备份及批准要求，其他 plan 保存工具和参数。unconfirmed 不代表已成功或未执行。

批准绑定计划内容和原文件版本，版本变化不会覆盖；同任务拒绝的目标不会再次索要替换许可。network 批准只限当前任务，支持沿用服务器持久授权。无法确认副作用时，skip 表示保留现状并让模型继续核对，retry 允许可能重复的重试。完整行为见[中断恢复与授权](RECOVERY-AND-AUTHORIZATION.md)。

## 文件传输

- `GET /v1/conversations/{id}/files`：`{items:[{path,name,size}],next_cursor:null,truncated}`，
  只列出会话工作目录，最多扫描 200 个目录并返回 200 个常规文件，超出时明确 truncated。
- `PUT /v1/conversations/{id}/files/{file_id}?filename=...`：原始二进制 body，最大 20 MiB，file_id 为 UUID。
  工作副本写入 `uploads/<file_id>/<filename>`，回执扩展为 `Resource`（保留 `path,name,size`）；相同 ID/name/content 重试返回原资源，冲突返回 409。PNG/JPEG/WebP/GIF 解码失败或超过 2400 万像素返回 422；其他图片格式按普通文件处理。
- `GET /v1/conversations/{id}/files/content?path=...`：认证后下载工作目录内相对路径，最大 20 MiB。
- `POST /v1/conversations/{id}/resources {path}`：将现有工作文件保存为原始资源快照，返回 `Resource`；同会话同路径同内容重复调用返回同一 ID。
- `GET /v1/resources?conversation_id=&query=&cursor=&limit=`：认证后按序号升序返回 `{items:Resource[],next_cursor}`；可选会话参数按其工作目录筛选，同项目会话共享资源。`query` 为最多 200 字符的名称子串，去除首尾空格并忽略 ASCII 大小写，`%`、`_` 按字面匹配。先在全部符合范围的资源中过滤，再分页；切换搜索词时从空游标开始，后续页沿用同一搜索词。也支持 `latest=true` 取最近窗口、`before=<previous_cursor>` 继续取更早资源，此时返回 `previous_cursor`、`next_cursor:null`，窗口内仍按序号升序；`cursor`、`before`、`latest` 不可混用。
- `GET /v1/resources/{UUID}/content?preview=false`：认证下载不可变原件；`preview=true` 返回最长边 2048 的 JPEG 图片预览，非图片返回 422。原件下载验证 SHA-256；设置 `nosniff`、私有且不缓存。此接口无资源删除功能。

`Resource` 为 `{id,conversation_id,path,name,mime_type,size,sha256,created_at}`（列表另含 `seq`）。原件保存在服务数据目录，工作副本可以修改；消息和运行保存资源元数据快照。模型请求临时填充图片 base64，用户附件的 base64 不写入 checkpoint；`view_image` 的工具返回图片属于实际工具历史。

文件接口均需要服务令牌，拒绝目录穿越、链接和受保护文件；额外执行目录授权不扩大手机文件下载范围。

## 内部运行契约

代码在 `backend/src/zhixing_next`。config.py 负责配置，store.py 负责业务事务，api.py 负责 HTTP，
worker.py 负责调度与生命周期，runtime.py/models.py/tools.py 负责实际智能体与工具调用。
memory.py 在成功运行后整理用户确认的持久事实；整理按运行顺序进行，增删改与处理标记在同一 SQLite 事务提交。运行时只带入少量相关记录，checkpoint 不充当长期记忆。

配置由 `config.py` 提供 `Settings`、`ModelConfig`、`PathGrant` 和 `load_settings()`：
Settings: data_dir: Path, workspace_root: Path, api_token: str, models: dict[str,ModelConfig],
roles: dict[str,str], grants: list[PathGrant], execution: ExecutionConfig, poll_interval: float=0.25。
ModelConfig: protocol: chat_completions|responses|gemini, model: str, api_key_env: str,
provider/display_name: str|None, reasoning_levels: list, base_url: str|None,
temperature: float|None, timeout: float=60, image_input: bool=False。服务端配置定义可选模型和供应商；角色默认值与主会话选择保存在 SQLite。
PathGrant: path: Path, writable: bool=False, overwrite: ask|allow（默认 ask）。服务端 TOML 配置引用环境变量，不将密钥写入 TOML。
ExecutionConfig: enabled=False, image="zhixing-sandbox:1", memory_mb=2048（256..16384）, cpus=2（>0..16）, timeout_seconds=120（1..1800）, network=none|bridge（默认 none）, network_authorization=ask|allow（默认 ask）。配置并不把 Docker 管理接口暴露给模型，部署见 [HARNESS-UPGRADE.md](HARNESS-UPGRADE.md)。

Store(settings) 的 worker 接口（同步短事务，每次调用独立连接）：
- claim_next(kind) -> run dict|None：领取会话未阻塞、无 running 运行的首条 queued，返回包含 project workspace_path 的运行。
- get_run(run_id) -> dict；get_assistant() -> dict；get_controls(run_id) -> `{cancel_requested,steers:[message dict]}`。
- acknowledge_steers(run_id, ids) -> None；add_event(run_id, type, data) -> None。
- finish_run(run_id, status, result=None, error=None) -> None：终态+助手结果消息+事件原子写入；失败/取消/中断阻塞该会话队列。
- enable_recovery(run_id)、pause_run(run_id)、interrupt_run(run_id)：标记已接入恢复协议、持久等待决定、处理在途中断。
- recover_interrupted() -> None：恢复协议内的 running 重新入队同一运行，最多自动三次；旧运行或超限标 interrupted 并阻塞队列。实际回执由运行时核对，不盲目重放。
- tick_schedules() -> None：触发唯一性、创建输入/运行、推进时间在一个事务内完成。
- heartbeat() -> None；worker_online() -> bool。初始化幂等；单 worker 实例由根实现进程锁。

运行时接口 `async run_agent(settings, run, *, persona, emit, controls, acknowledge) -> str`：
emit(type, data)、controls()、acknowledge(ids) 均为异步回调。取消可通过 asyncio task cancellation 打断，
模型与工具步边界检查 controls；steer 使用稳定消息 ID 注入真实模型上下文，checkpoint 落盘后才 acknowledge。
模型 ID、思考档位和搜索服务 ID 在消息入队时写入运行记录，worker 按快照调用；LangGraph thread 以 conversation_id 标识，checkpoint 使用 data_dir 下独立 SQLite。worker 在运行开始时读取子智能体配置快照；主知行只委派已配置命名助手，直接子智能体会话只获得自己的工具。搜索密钥只存服务端 SQLite，不进入消息、运行记录或 API 回执；联网结果是外部资料，回答应引用来源链接。
运行时发现原生 interrupt 后抛出 RunPaused，由 worker 保存等待状态并释放执行槽。恢复时复用同一 checkpoint 和步骤回执；模型/权限/助手/记忆重置/SDK 版本变化会拒绝旧恢复。旧版无恢复标记的运行仍保留 interrupted 行为，不宣称任意工具能自动安全续跑。

主知行聊天工具 `start_background_task(instructions)` 通过同一 Store 入队任务，沿用当前用户附件（包括 Steer），返回真实 `run_id/status`；同运行同要求去重。主知行的 `list_scheduled_tasks`、`schedule_task`、`set_schedule_enabled` 操作已有持久计划服务，不发送外部通知。执行任务通过 DockerSandbox 接入 Deep Agents 的 execute/文件工具；`browser_action` 操作任务内 Chromium，`view_image` 查看实际图片，`publish_artifact` 校验并发布产物。主知行的 `copy_file` 在已授权文件目录间搬运最多 20 MiB 二进制文件。子智能体不自动获得 Shell、浏览器、调度或宿主目录挂载权限。


## 供应商管理（v10）

所有接口需服务访问令牌。`GET /v1/models` 保持原响应结构，只列启用的供应商下已启用模型，`ready` 仅表示存在凭据。无可用默认模型时相应角色为 null。

- `GET /v1/providers` → `{items: Provider[]}`。Provider 为 `{id,name,protocol,base_url,enabled,revision,has_api_key,credential_source: stored|environment|none,models: ManagedModel[]}`，不含密钥或环境变量名。
- `POST /v1/providers {name,protocol: chat_completions|responses|gemini,base_url,api_key?,enabled?}` → 201 Provider。
- `PUT /v1/providers/{id}` 使用上述字段及 `revision`、可选 `clear_api_key`。省略或 null 密钥保留原值，空串拒绝；清除与替换不能同时指定。旧 revision 返回 409 `catalog_changed`。返回 Provider。
- `DELETE /v1/providers/{id}?revision=` → `{deleted:true}`，删除供应商及模型，清除不可用默认引用与会话模型；不删除聊天和任务。
- `POST /v1/providers/{id}/discover` → `{items:[{model,name}],truncated:bool}`，读取供应商远端目录，不直接保存模型。超时/响应过大/错误返回脱敏的 502 `provider_discovery_failed`；无密钥返回 422。
- `POST /v1/providers/{id}/models {revision,models:[ModelInput]}` → 201 Provider。1–200 个模型，同供应商相同实际 ID 跳过；不覆盖已添加模型。
- `PUT /v1/providers/{id}/models/{modelId} {revision,model:ModelInput}` → Provider。保留内部 ID，可以修改实际 ID 与显示名；不兼容协议/思考参数返回 422，整批失败不会部分写入。
- `DELETE /v1/providers/{id}/models/{modelId}?revision=` → Provider。删除/停用后清理无效引用，已入队配置保留。
- `POST /v1/providers/{id}/models/{modelId}/test` → `{checks:[{kind:reply|stream|tools,ok,elapsed_ms,message?}]}`。每项单独报告，不把 HTTP 200 当作测试通过；最多三个各 15 秒、256 输出 token 的请求，不执行探针请求的工具。

ModelInput 为 `{model,display_name?,enabled?,image_input?,reasoning_levels?,reasoning_effort?,temperature?,timeout?}`；默认启用、文本输入、模型默认温度、60 秒超时。已识别模型按实际 ID 自动匹配思考档位，未知模型使用显式 `reasoning_levels`；空列表表示不可调整。温度 0–2，超时大于 0 且不超过 300 秒；默认思考值必须可用（省略支持列表时由服务端匹配）。已识别的 Gemini 可设置默认思考，2.5 Flash 可关闭，Pro 与 3 系列不能关闭；未知 Gemini 不接受默认思考及 none/xhigh/max。`reasoning_kind` 和 `reasoning_labels` 是可选展示元数据，开关模型的 `high` 显示“开启”。规则与请求转换见[模型思考适配](MODEL-THINKING.md)。ManagedModel 在原 ModelInfo 上增加 `enabled,temperature,timeout`。

配置和凭据保存在服务端 `app.sqlite`；API 与 worker 按操作读取新配置。私有运行快照独立于公开运行记录，完成、失败、取消后清除；可恢复中断任务保留。v9 现有 TOML 条目仅在迁移时导入一次，详见[升级说明](PROVIDER-MANAGEMENT.md)。

## 执行闭环与必要问答（v11）

- `GET /v1/input-requests?conversation_id=&run_id=` 返回最多 50 个 pending 问题，分页形态 `{items,next_cursor:null}`。条目有 `id,run_id,question,options,state,answer,created_at,answered_at`。
- `POST /v1/input-requests/{id}/answer {answer}`：回答 1–10000 字，去除首尾空白；接受自定义文本，不限于建议选项。同一回答重试幂等，冲突/过期返回 409；认证与其他端点一致。
- Run 增加 `phase=input`：保持 queued 并等待回答，不占 worker 执行槽。存在未决批准时先等批准，两个条件都满足才继续；取消后问题失效。
- `GET /v1/runs/{id}/report` → `{usage,steps}`。usage 为 `model_attempts,tool_calls,input_tokens,output_tokens,unknown_usage,active_seconds`；steps 含 `id,description,status:pending|passed|blocked,evidence`。证据 `kind=command` 表示实际断言命令，`kind=agent_review` 表示模型核对持久操作回执。
- 运行事件增加 `retry,model_error,usage,input_required,input_answered,task_plan,task_check`；原有事件增量游标不变。未完成的条件不会因模型输出一句“完成”就变成 passed。
- Agent 输入/输出增加可空 `model_id`。空值跟随当前任务模型，非空须指向启用模型；与主模型一起在入队时保存服务端私有快照。权限仍以助手显式工具集合为界。
- ModelInput、ModelInfo 增加可空 `context_window`（4096–10000000 token）；通过 SDK profile 决定压缩阈值。省略时保持 SDK 模型资料/默认行为。

GitLab 主机、凭据环境变量、项目范围及写开关由服务端配置；模型只能调用已暴露的项目/议题工具。写操作产生 `kind=external_write` 的现有 approval 卡片；它复用 approve/deny 路径。中断后结果无法确认时仍使用 uncertain 的 retry/skip，不能把 HTTP 超时当成未提交。具体配置、迁移及验证限制见[执行闭环验收](HARNESS-ACCEPTANCE-2026-09-30.md)。

`GET /v1/resources/{id}` 返回认证后的单份资源元数据（与列表相同），用于重新打开不在当前分页窗口中的最近文件；无此资源返回 404。

`GET /v1/schedules?ids=<id>&ids=<id>&limit=100` 可按最多 100 个 ID 刷新已加载计划，仍在分页前过滤、受原认证保护；省略 `ids` 保留原游标列表。客户端用它更新首 100 条之外的执行状态。
