# HTTP 与运行接口

2026-10-29：当前 App 仅连接 [DSH 插件接口](../plugins/dsh-zhixing/README.md)，`/v1/status.runtime` 为 `dsh`。财务、健康、联合餐费和 `GET /v1/business/schema?domain=finance|health|life` 由同进程原生业务插件提供，使用 DSH `storageDomain` 持久保存；不转发 Python 服务。记忆、资料、搜索供应商、旧人格与任务路由不再由此出口提供。以下先列当前 DSH 协议，后面的 Python 部分仅为历史契约参考。

2026-10-30 权限接口：`GET /v1/status` 增加 `permissions: {current, options}`（新会话默认值），`GET /v1/conversations/{id}/dsh` 返回所选原生版本的同名权限对象。值为 `read-only`、`workspace-write`、`danger-full-access`；仅公布宿主当前提供的选项。宿主未挂载权限服务／命令时为 null；其他自定义当前值保留原样，不映射为已知模式。

`PUT /v1/conversations/{id}/dsh/permissions` 接收 `{permission, version}`。version 必须匹配当前原生版本，过期返回 409；不支持的值为 400，无权限服务为 503。执行宿主原生 `/permission` 命令，检查成功回执和生效值并 flush 后，返回 `{current, options}`；同值重试不重复执行命令。不接受任意命令字符串，不修改宿主全局默认值。`POST /v1/conversations` 可传可选 permission，先校验能力，再于首次消息前应用。历史编辑／重答新建的分支继承源会话当前可用权限预设，避免较早的历史前缀恢复更宽的旧权限；已有版本各自保存权限。

DSH 聊天快照的 `queue` 来自原生 Session state，保留 `queued`／`steering` 位置；`POST /v1/conversations/{id}/dsh/queue/{itemId}` 接收原生 `remove`、`steer`、`edit` action，并在持久化后返回。`GET /v1/conversations/{id}/dsh/images/{attachmentId}` 需要连接令牌，仅解析本对话历史中的原生图片引用，返回真实图片字节和媒体类型；不存在于该会话的引用返回 404，不接受任意文件路径。客户端提交附件前持久保存上传 receipt，发送重试复用 receipt 与消息请求 ID。

DSH 对话体验第一轮增加以下接口（均需连接令牌）：

| 接口 | 请求与回执 |
| --- | --- |
| `PUT /v1/conversations/{id}/title` | `{ "title": "名称" }`；非空名称交给 DSH 原生 rename，flush 后返回更新的会话。 |
| `GET /v1/conversations/search?q=...&sort=...` | 从本出口会话的原生持久记录做字面匹配，兼容宿主未开启搜索索引。每个会话返回首条用户／助手正文命中的 `message_seq`、`message_id`、摘要；仅标题命中则位置为 null。运行上下文、思考、工具参数不作为正文命中。`oldest` 按会话更新时间升序，其余按降序；没有声称实现全文相关性评分。 |
| `GET /v1/conversations/{id}/dsh/files/{attachmentId}` | 从本会话的持久消息／工具结果解析原生 file 引用，流式读取原件；不接受客户端文件路径。跨会话引用 404。HTTP 流结束前等待宿主完整性校验；失败中断下载。 |
| `GET /v1/conversations/{id}/dsh/files/{attachmentId}/text` | 文本／代码文件的 UTF-8 预览，返回 `resource_id/content/format/truncated`；最多展示前 256 KiB，仍校验完整原件。Markdown 的 format 为 markdown，其余为 text；不支持预览的二进制文件返回 415，仍可下载。 |

文件接口消费 DSH 原生附件引用。新的工作区交付使用下述原生 present 声明；文本预览长度是显示边界，不限制宿主执行或原文件下载。

DSH 对话体验第二轮增加历史版本与工作区交付（认证与逻辑对话 ID 不变）：

搜索仅检索当前所选版本，结果额外返回 `message_version`；客户端发现结果版本已变化时提示重新搜索，不按复用的 seq 错误定位。

| 接口 | 请求与回执 |
| --- | --- |
| `POST /v1/conversations/{id}/dsh/revisions` | `{id, kind: "edit"或"retry", version, seq, text?, attachments?}`。id 是稳定请求编号，version 是当前原生会话 ID，seq 是所选用户消息或助手回复的原生事件位置。edit 提供 text 与保留的原附件 ID 数组；不能引用外部附件。retry 使用对应用户消息的原始正文与附件。返回 `{active, versions}`；同请求重试不重复执行，同编号改内容、版本过期或执行中返回 409。 |
| `PUT /v1/conversations/{id}/dsh/version` | `{expected, version}`，仅可切换本逻辑对话已接受的版本，检查当前版本与原生空闲／队列状态。外部版本 404。未来发送、取消、模型选择和附件读取作用于所选版本；标题属于逻辑对话。 |
| `GET /v1/conversations/{id}/dsh?offset=N&version=...` | 增加 `history: {active, versions:[{id,label,source?,seq?,userIndex?,group?,kind?}]}` 。版本不一致时从原生 seq 0 返回，客户端清空旧版本事件。 |
| `POST /v1/conversations/{id}/messages` | 增加可选 version；必须匹配当前版本，否则 409，客户端保留草稿。不传时作用于当前版本。 |

DSH 历史追加写入。本插件使用宿主 `buildForkSeed` 与 Agent 创建／恢复服务，从对应用户消息之前建立原生分支，清空历史中尚未消费的 inbox 后重新提交。保留预设、工作目录、模型选择与工作区关联；不是向原会话末尾追加修改要求。分支选择保存在宿主 `storageDomain` 的 `zhixing_chat` 域，写盘后确认；准备记录与确定的子会话 ID 支持中断恢复。原版与后续回答保留，**版本切换不回滚工作区和工具副作用**。

2026-10-29 重做后的文件交付复用 DSH 标准预设的 `present(files)`，不注册自建的发布工具。App 从 `deliverables/presented` 事件显示文件卡；同一回复再次交付同一路径时更新原卡片。

| 接口 | 请求与回执 |
| --- | --- |
| `GET /v1/conversations/{id}/dsh/deliveries/{seq}/{index}` | seq/index 指向当前或 `?version=` 指定的本逻辑对话版本内的真实交付声明。通过宿主 `workspaceFiles.stat/readBytes` 按页流式读取，无额外文件总量限制；下载中版本变化会中断。不接受自传路径或其他逻辑对话的版本。 |
| `GET /v1/conversations/{id}/dsh/deliveries/{seq}/{index}/text` | 通过宿主 `workspaceFiles.read` 返回 `resource_id/content/format/truncated`，预览页长度沿用宿主默认值。Markdown 格式化呈现，其余文字按原文呈现。 |

原生 `present` 指向工作区文件的**当前内容**，不承诺不可变快照；删除或失去权限后显示真实错误。自建 `zhixing_publish_file`、`/dsh/artifacts` 与发布副本已经移除；保留旧文件备份，不为旧客户端维护这套流程。没有新增宿主工具白名单、预算或执行轮数限制。

历史摘要新增 `userIndex`（逻辑用户消息序号）、`group`（同一分叉点）与 `kind`（edit/retry），让前端把真实版本放到对应回复下方；旧数据缺少这些字段时仍可从对话设置访问完整版本列表。

## 当前 DSH 业务接口

财务、健康与联合餐费沿用下文对应数据字段和结果语义；以 `/v1/business/schema` 返回的路由和 schema 为准。`/v1/finance/observations` 只读取迁入的早期资产观察，不把它伪装成即时余额，也不重复计入账本。金额与汇总使用十进制计算；同餐饮食与付款在一个原生存储提交内变更，持久化失败不返回成功。请求去重、版本冲突和取消分别验证。

`zhixing_service` 在原生工具上下文中自动带入创建记录或联合餐费纠正的来源消息与会话编号，模型不用填写或查找这些内部字段。直接调用 HTTP 的客户端仍按 schema 提供自己的稳定请求编号。旧数据只通过操作员指定的启动导入文件迁移，不提供远程导入接口。

## 历史 Python 接口（新客户端不调用）

状态：2026-10-23，当前源码包含数据库 v15 的人格成长、主动偏好、目标跟进与心跳，保留既有工具契约与 Agent 协作。历史安装、部署及验收状态以各版发布说明为准；本页描述接口，不代表对应版本已经上线。实际运行能力与限制见[后端说明](../backend/README.md)。

## 交付范围

Python FastAPI + SQLite，API 与 worker 独立进程；React Native 客户端连接真实后端。
当前产品提供会话、人格及其演化、财务／健康子 Agent、消息 Queue/Steer、取消、服务记录、轻量记忆与个人目标跟进。旧项目、任务和通用计划 API 保留兼容，手机入口及主 Agent 创建这些工作的工具已移除；v12 迁移停用已有通用计划。
文件/图片的自动记忆提取、外部 harness 与推送通知留作后续。模型未配置时明确失败，不返回模拟助手回复。

## 公共约定

接口前缀 `/v1`；除 `/healthz` 外均需要 `Authorization: Bearer <服务访问令牌>`。
JSON 字段使用 snake_case；创建与更新时间为 UTC ISO 8601。财务业务日使用 `YYYY-MM-DD`，健康发生／测量时间必须带 UTC offset 并保留所述日期语义。旧分页列表为 `{items: [], next_cursor: null|string}`；新服务列表形态见下文。
错误 `{error: {code: string, message: string}}`。请求 ID/消息 ID 由客户端生成；重试相同 ID 与相同内容返回原记录，
相同 ID 不同内容返回 409。限长与枚举由入口校验；旧列表默认 50，最大 100，新健康列表默认 100、最大 500。
用户和模型供应商密钥分离；App 只持有服务访问令牌。

## 人格成长与主动跟进

以下接口同样要求服务令牌。用户设置的 `/v1/assistant` 人格与演化记录分开；模型工具使用稳定操作键保存幂等回执，HTTP 修改可通过 `expected_revision` 检查并发更新。修订不匹配返回 `409 revision_conflict`，读取最新状态后再合并，不覆盖其他修改。设计与交付边界见[人格成长与主动服务](MUSE-GROWTH.md)。

- `GET /v1/growth`：返回 `{revision,updated_at,evolved_persona,persona_reason,persona_memory_refs,preferences,learned_skills,understanding,goals,memory_versions}`。引用已删除或旧版本记忆的人格／方法／理解不再返回有效内容。`memory_refs`／`memory_versions` 是记忆 ID 到 `updated_at` 的映射，不包含原始聊天。`goals` 返回现有目标全部状态。
- `PATCH /v1/growth/preferences`：部分更新 `{expected_revision?,conversation_id?,enabled?,maintenance_enabled?,timezone?,quiet_start?,quiet_end?,daily_limit?,min_interval_minutes?,snooze_until?,topics?,guidance?}`，返回完整偏好和全局 `revision`。`topics` 为主题到 `allow|block|null` 的映射，`guidance` 为情境／表达键到文字或 `null` 的映射；只合并所给键，`null` 删除对应一项，不清空未提及的偏好。每个映射最多 40 项，键最多 80 字，指导文字最多 1000 字。启用主动消息须有实际目标会话；保存偏好不创建跟进。
- 偏好默认 `enabled=false,maintenance_enabled=true,timezone=Asia/Shanghai,quiet_start=22:00,quiet_end=08:00,daily_limit=3,min_interval_minutes=240,snooze_until=null`。时区须为 IANA 名称；安静时段为 `HH:MM`，跨午夜有效，同时设为 `null` 可清除，起止相等表示不限制。每日上限 1–12，最短间隔 15–10080 分钟；`snooze_until` 须带时区，`null` 清除暂停。设置关闭或暂停不会伪造成功投递。
- `PUT /v1/growth/persona {content,reason,expected_revision?,memory_refs?}`：更新演化人格，返回 `{evolved_persona,persona_reason,memory_refs,revision}`。HTTP `content` 最多 4000 字，可为空以清除；`reason` 为 1–1000 字。涉及个人事实的内容须引用当前记忆，最多 100 个引用。该接口不修改 `/v1/assistant` 的用户人格。
- `PUT /v1/growth/skills/{key}`：请求与人格更新相同，保存一条有界方法记录；内容须非空、最多 4000 字，最多保存 50 条。返回 `{key,content,reason,memory_refs,revision,created_at,updated_at}`，其中记录 `revision` 独立递增。`DELETE /v1/growth/skills/{key}?expected_revision=` 删除该方法，返回 `{deleted,revision}`。这里的 `expected_revision` 检查全局成长修订。方法不是可执行插件或工具授权。
- `POST /v1/growth/goals {id,conversation_id,title,context?,topic?,status?,next_check_at?,interval_seconds?,expected_revision?}`：创建目标并返回 `{id,conversation_id,title,context,topic,status,next_check_at,interval_seconds,revision,created_at,updated_at}`。目标 ID 和方法 key 均为 1–80 个中文／英文字母、数字及 `_.:-`，首字符须为中文／英文字母或数字。标题最多 200 字、上下文最多 4000 字、主题最多 80 字，同时进行中或暂停的目标最多 100 条。
- `PATCH /v1/growth/goals/{goal_id}`：按相同目标字段部分更新，不能变更 ID 或原会话；`expected_revision` 检查该目标自身修订。`status=active|paused|completed|cancelled`，默认 `active`；暂停保留检查时间而不执行，完成／取消清空 `next_check_at`。下次检查时间须带时区；`interval_seconds` 为 900–31536000 秒，`null` 表示一次性。未提供的字段保持原值。目标保存成功不等于主动消息已经启用或送达。
- `GET /v1/growth/heartbeat`：返回 `{next_check_at,running,last_success_at,failure_count,last_error,receipts}`；`receipts` 为最多最近 20 项 `{id,status,started_at,finished_at,message_id,topic,reason}`。状态包括 `running|silent|delivered|stale|failed|interrupted`；只有 `delivered` 及实际 `message_id` 表示聊天消息已落库，`silent` 不表示用户目标完成。错误只保存类别，不返回供应商私有错误正文、内部输入哈希或记忆版本快照。

心跳沿用同一个 worker，优先记忆模型并回退聊天默认模型；每次最多提供最近更新的 200 条当前记忆，生成引用须在本次提供范围内。写入前重新检查全库当前记忆版本、成长、目标、模型与主动偏好；消息与回执同事务保存。心跳不创建普通用户运行、不执行图工具，聊天消息保存为 `role=assistant,origin=heartbeat,run_id=null`，按已有消息同步接口读取；客户端不为其请求运行过程或取消运行。该能力没有远程推送；worker 离线时不能执行检查。

## HTTP 接口

- `POST /v1/runs/{run_id}/conversation-messages {id,target_conversation_id,message}`：当前活动用户运行向已有其他对话发起只读咨询。`id` 是本次投递的稳定请求 ID；目标消息、目标运行与投递回执同事务创建，相同 ID 换内容／目标返回 409。返回 `delivery_id,target_run_id,target_conversation_id,status,terminal,needs_attention,read_only:true`；queued/running 不代表咨询完成。内部咨询不能继续投递，拒绝本对话、阻塞目标、依赖环与单运行超过八次投递。
- `GET /v1/runs/{run_id}/conversation-messages`、`GET /v1/runs/{run_id}/conversation-messages/{delivery_id}`：查询该源运行的实际投递状态与结果，跨源读取返回 403。终态保留 completed/failed/cancelled/interrupted；结果窗口最多 16000 字，附 `result_truncated,reply_message_id`，可通过既有历史消息读取能力继续获取。取消源运行不撤回已接收的独立咨询。
- 跨对话等待由运行时 `wait_conversation_replies` 使用 LangGraph interrupt；运行状态为 `queued,phase=agent_wait` 时释放聊天槽，完成／需要处理后恢复。原目标的模型上下文只由正常 worker 领取流程写入。等待阶段允许用户对该 run 发送 Steer 或取消。内部消息返回 `origin=agent_message,source_conversation_id,delivery_id`，运行也带 `origin=agent_message`；不能作为普通用户排队消息撤回或提升为引导，不进入个人记忆及财务用户证据。
- 运行内研究工具为 `start_agent/send_agent/wait_agents/close_agent`；具体生命周期、只读白名单、预算和重启边界见 [Agent 协作](AGENT-COLLABORATION.md)。跟进／等待工具在已有对应句柄后才向模型提供。

- `GET /v1/status`: `{model_ready: bool, worker_online: bool, execution_available: bool, execution_reason: string|null, file_tools_available: bool}`；`model_ready` 按当前聊天/执行默认模型及服务端密钥判断，不代表供应商已通过调用。`execution_available` 检查启用配置及 Docker 镜像可见性，实际启动仍可能失败，以执行回执为准。
- `GET /v1/models`：返回 `{items,roles}`。每个模型只公开 `id,name,model,provider,protocol,ready,image_input,reasoning_levels,default_reasoning_effort,reasoning_kind,reasoning_labels`；`image_input` 是服务端对端点能力的声明，不是实时探测。不返回密钥、环境变量名或 Base URL。`roles` 为聊天、执行、记忆整理的当前默认模型 ID。
- `PUT /v1/models/roles/{role} {model_id}`：`role` 为 `chat|task|memory`，保存角色默认模型。模型须已在服务端配置；未配置专用记忆模型时，整理使用当前聊天默认模型。
- `GET /v1/memories?cursor=&limit=&query=`：返回个人语义记忆 `{items,next_cursor}`；每项含 `id,content,source_message_id,created_at,updated_at,seq`。`query` 最多 200 字，去除两端空白后按内容字面子串搜索全库，忽略 ASCII 大小写，`%` 和 `_` 不作通配符；先筛选再按原有序号升序分页，空白查询等同未筛选。只读当前记忆，不返回原始聊天或内部去重键。
- `POST /v1/memories {content}`、`PATCH /v1/memories/{id} {content}`、`DELETE /v1/memories/{id}`：后端直接写入、纠正或忘记；内容最多 500 字，凭据类内容拒绝写入。手动纠正会清除已不适用的聊天来源；自然语言整理纠正绑定本次已应用的用户来源。纠正和遗忘会阻止旧的待整理、运行中或失败整理任务在稍后写回旧说法；之后的新运行仍可形成记忆。删除记忆不删除原会话或文件，旧任务隔离的边界见[记忆说明](MEMORY.md#纠正与遗忘)。
- `GET /v1/memories/status`：返回 `{pending,failed}` 整理运行数；`POST /v1/memories/retry` 将失败的整理重新排队，返回 `{retried}`。手机侧栏可以查看和忘记记忆，整理状态仍由后台处理。
- `GET /v1/conversations/recent?limit=10`：按 `updated_at` 降序取最近活动会话，覆盖较早建立的话题；不是创建序号窗口。
- `GET /v1/conversations?project_id=<id>`：在分页前按项目过滤，支持现有 `cursor`、`latest`、`before` 语义；无此项目返回 404。
- `GET /v1/conversations/search?q=&sort=relevance|newest|oldest&limit=`：认证后搜索全部会话标题和未拒绝消息正文，空格分词取交集，支持中文、部分词和字面量 `%`、`_`。最多返回 100 项 `{items:[{conversation_id,title,agent_id,updated_at,message_id,message_seq,snippet}]}`；标题命中优先于正文命中，同级按更新时间排序。当前单用户 SQLite 直接检索，历史量增长后可再引入全文索引。
- `GET /v1/search/providers`：列出已配置搜索服务 `{items:[{id,name,kind}],next_cursor:null}`，不返回密钥。`POST /v1/search/providers {name,kind:brave|tavily|serper,api_key}` 在服务端保存密钥并返回 `{id,name,kind}`；`DELETE /v1/search/providers/{id}` 删除服务，若排队或运行中的消息正在引用则返回 409。
- `GET /v1/assistant`, `PUT /v1/assistant`: `{name, persona}`，人格是用户编辑的持久文本。
- `GET /v1/agents`, `POST /v1/agents`, `GET/PUT/DELETE /v1/agents/{id}`：子智能体配置
  `{id,kind: service|custom,service: string|null,name,description,instructions,tools: string[],visible,created_at,updated_at}`。
  创建/修改输入 `{name,description,instructions,tools,visible}`；固定服务助手不可删除，且工具由服务固定。删除自建助手前需完成其排队或运行中的任务；旧会话保留并转为主知行会话。
  自建助手显式选择已注册的物理文件／图片／公开网页及财务／健康服务工具；固定服务助手工具由服务维护。服务器目录授权和运行时工具白名单仍生效，实际模型未开启图片输入时不提供 `view_image`。固定服务包括 `finance` 与 `health`。
- `GET /v1/finance/observations`（旧观察接口）：`{balances: FinanceObservation[],recent: FinanceObservation[]}`。保留旧 CNY 金额观察值读取；新消费使用下方 transactions 服务，余额继续作为观察值；`balance` 为各平台最后一次观察，`income`/`expense` 取最近 20 条。记录包含 `id,kind,platform,amount,note,conversation_id,created_at`。这不是实时账户查询或自动对账接口。
- `GET /v1/projects/{id}`：读取指定项目；不存在返回 404。
- `GET /v1/projects`, `POST /v1/projects {name}`: 项目 `{id,name,workspace_path,created_at}`；路径由服务器创建。
- `GET /v1/conversations`, `POST /v1/conversations {title,project_id?: string|null,agent_id?: string|null}`:
  会话 `{id,title,project_id,agent_id,blocked: bool,created_at,updated_at}`；`agent_id=null` 为主知行。
- `GET /v1/conversations/{id}`：单个会话及当前 blocked 状态。
- `PUT /v1/conversations/{id}/model {model_id:string|null,reasoning_effort:auto|none|minimal|low|medium|high|xhigh|max|null}`：主知行与绑定专用助手的会话均可设置聊天模型和思考档位；null 表示继承助手配置或角色默认模型。单次请求模型优先于会话模型，再继承助手配置与角色默认模型。档位必须在模型声明的 `reasoning_levels` 内。设置只影响之后入队的聊天，已提交的运行保留入队时的模型快照。
- `GET /v1/conversations/{id}/messages?cursor=&limit=`: 按序号升序，消息
  `{id,conversation_id,role: user|assistant,content,attachments: Resource[],intent: queue|steer,run_id:string|null,status: accepted|applied|rejected,created_at,seq}`。
  心跳主动消息额外带 `origin:heartbeat`，`role=assistant,run_id=null`；它是独立消息，没有普通运行过程，不构成新的用户输入或业务授权。
  自动转交的任务输入额外带 `origin:assistant_task`，手机显示为后台任务，不作为用户事实提取记忆；此字段只由服务端设置。内部转交可汇集多次 Steer 的附件，外部每条消息仍最多 8 份。
  原先以 queue 提交、之后通过下方原子操作改为引导的同一消息额外带 `submitted_intent:queue`；`intent:steer` 表示当前投递方式。客户端恢复未收到回执的原始请求时以 `submitted_intent ?? intent` 核对提交方式，不改写本机已保存的请求。
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
- `POST /v1/runs/{id}/queued/withdraw`: 仅撤回普通用户提交、`kind=chat,status=queued,phase=normal,started_at=null` 且尚未取消的输入，返回 `{message,run}`。同一撤回可以重试；worker 已领取时返回 `409 stale_queue`，不会转为取消正在运行的任务。撤回不改变当前执行或已有会话阻塞；后台任务、等待批准／回答、恢复任务及已改投为引导的输入不能使用此接口。
- `POST /v1/runs/{id}/queued/steer {target_run_id}`: 将上述尚未开始的队列输入原子改投到同会话、未请求取消的用户 running 或 queued+agent_wait 运行，返回 `{message,run:目标运行,source_run:已撤回的原队列运行}`。内部只读咨询不能作为引导目标。保留同一 message ID、顺序、正文、附件、创建时间和原始 `request_json`；不重新上传附件、不新建消息／运行，也不把原队列的模型、思考或搜索配置覆盖到目标。图片按目标已保存的模型快照校验，不支持时返回 `422 image_not_supported` 并保持原队列。source 被领取或 target 已结束／取消时返回 409，整个操作无部分修改。引导 agent_wait 时同事务清除旧等待依赖并转为 recovering。
  成功后重试同一 source／target 返回同一投递的当前回执，即使引导已应用或目标已结束；不同目标返回 `409 stale_queue`，不会再次投递。原 queue POST 仍须原样重试，返回同一已改投消息和目标运行。操作与 worker 领取、结束共用 SQLite 写事务；禁止客户端使用“先取消再发送”模拟转换。原队列模型快照被清理，目标配置、checkpoint 和实际效果不变。
- `GET /v1/runs/{id}/events?after=0&limit=100`: `{items: [{seq,run_id,type,data,created_at}],next_cursor}`。
  类型包括 started/progress/tool/queue_promoted/steer_applied/execution/artifact/operation/approval/paused/recovering/completed/failed/cancelled/interrupted；序号单调递增。`queue_promoted.data={message_id,source_run_id}` 只表示同一排队输入已接受为目标引导；实际应用仍以 checkpoint 后的 `steer_applied` 为准。
  模型实时显示使用 additive 事件 `assistant.reset`、`assistant.snapshot`、`reasoning.snapshot`。reset 的 data 为 `{stream_id}`，每次运行实际开始或从 checkpoint 恢复时先发，清除同一 run 旧的未确认实时正文／思考，不删除工具回执或已落库消息。snapshot 为 `{stream_id,message_id,text,truncated?}`：同一 key 的 text 是完整替换快照，禁止拼接；不同模型回合／重试使用不同 message_id。客户端按 run 隔离、按 event seq 排序去重，仅接受当前 stream_id，正文优先最新回合；最终助手消息落库后优先显示最终消息。
  快照只含模型实际提供的正文或显式 reasoning 内容；不发送系统提示、模型请求、签名、工具参数或完整 graph state。仅投影主图 `model` 节点，内部摘要及子图 token 不冒充当前助手正文。首片立即发送，之后约 100ms 或累计 1024 字符更新，步骤结束刷新；每字段上限 65536 个 UTF-16 code units（与手机字符串长度一致，不截断 emoji 代理对），每次运行实际执行最多 64 个模型消息、512 个快照及 2 MiB JSON 快照负载（其中 1 MiB 与 128 次快照专留步骤末尾刷新），所有字段累计捕获最多 128 Ki UTF-16 code units。增量预算耗尽不再持续写中间快照，步骤结束、异常或取消前仍尝试写入最后的有界快照；触及显示限额发一次 `assistant.truncated {stream_id,reason:"display_limit"}`，截断字段带 `truncated:true`。最终消息仍按原流程完整保存，不受展示限额截断。`assistant.attempt {stream_id,message_id,status:completed|failed}` 标明一次实际模型调用的结束／失败；重试失败片段保留为失败尝试，不能拼进后续成功正文。供应商不提供思考时不产生 reasoning 事件。
  这些只是展示投影，不是 checkpoint／成功回执，不创建额外聊天消息，不改变 token 预算、工具批准或恢复幂等；取消、失败和恢复仍以原有持久事件及最终状态为准。`tool.data={tool,tool_call_id,status:started|completed|failed,cancel_requested?}` 继续表示实际工具阶段，客户端仅显示安全工具名及状态，不把工具参数或输出直接当聊天正文。
  `operation.data={id,tool,state}`；`approval.data={id,kind?,status}`；`paused.data={reason:approval|resume}`；`recovering.data` 包含自动恢复的 `attempt` 或手动恢复的 `requested:true`。
  `execution.data` 含 `id,status: started|running|completed|failed|timed_out|cancelled|interrupted`，按阶段提供 `timeout_seconds,output,exit_code,truncated,stopped,reason`。命令输出最多 64 KiB；只有确认容器已停止才返回 `stopped:true`。重启清理使用容器 ID 和 `reason:worker_restart`，普通命令使用独立执行 ID。
  `artifact.data` 为 `{resource:Resource,verification:{format,sha256,checks,visual_checked:false,...}}`。结构检查不代表视觉检查；成功运行的助手消息附带该运行所有已发布产物，失败前已发布的资源仍可在资源库查看。
- `GET /v1/conversations/{id}/reply-processes?run_ids=A&run_ids=B`：一次读取本会话最多 50 个运行的持久显示过程，返回 `{items:ReplyProcess[]}`；缺失运行或混入其他会话整体返回 404，空列表／超限返回 422。客户端按当前历史窗口分批取，避免每条消息单独请求。无需数据库迁移，已有持久事件可恢复相应历史；从未产生过显式思考／工具事件的旧回复不会补造过程。
  `ReplyProcess={run_id,status,phase,stream_id:string|null,cursor:number,parts:ReplyPart[],final_message_id:string|null,final_part_id:string|null,truncated:boolean}`。`ReplyPart={id,type:text|reasoning|tool,seq,stream_id?,message_id?,text?,name?,tool_call_id?,status?:started|completed|failed,attempt_status?:completed|failed,truncated?}`。`id` 稳定，`seq` 是该片段首次出现的事件序号，后续快照替换文字、工具回执更新同一片段，按首次出现顺序交错展示。失败尝试显式标注，恢复 reset 只移除上一次未确认的模型片段，已实际产生的工具回执保留。工具仅公开清理过的名称、调用标识和状态，不含参数、结果、供应商元数据或 graph state。
  每运行最多最近 2048 个白名单显示事件、64 个片段、累计 128 Ki UTF-16 code units；超出明确 `truncated:true`，文字优先保留最近片段。最终正文由原助手 Message 完整保存，`final_part_id` 只指向能够对应最终消息的最后正文片段：客户端以该 Message 的完整正文替换这一片段；没有对应片段时在过程后追加最终正文一次，不能把工具前说明覆盖成最终答案。取消／失败没有最终助手消息时，仍可通过其原 run_id 展示各自实际收到的部分内容。状态、片段、最终消息引用和续读游标在同一 SQLite 读取快照内产生，游标不会越过尚未返回的新事件。
- `GET /v1/runs/{id}/display-stream?after=0`：需相同 Bearer 鉴权的 `text/event-stream`，支持 `Last-Event-ID`（与 after 取较大有效值），运行不存在时在发送流响应前返回 404。约每 100ms 检查持久事件；15 秒无相应活动发 `: heartbeat`，客户端断开只关闭读取，不取消运行；终态事件读尽后发送 done 并关闭。响应 `Cache-Control: private, no-store` 与 `X-Accel-Buffering: no`，反向代理仍须允许长连接并关闭缓冲。
  `event: display`、`id: <事件seq>`、`data: {seq,run_id,type,data,created_at}`；公开类型为 `assistant.reset/assistant.snapshot/reasoning.snapshot/assistant.attempt/assistant.truncated/tool/started/paused/recovering/completed/failed/cancelled/interrupted`。文本／思考／工具字段仍按上述白名单裁剪；终态 data 不含 result/error，完整最终回复从原 Message 读取。`event: cursor`、`id: <seq>`、`data:{cursor}` 推进已读位置，包括已过滤的内部事件；`event: done`、`data:{run_id,status,cursor}` 表示持久事件已经读尽。客户端以事件 seq 去重、按 stream_id reset，终态再刷新最终消息；不支持 SSE 的旧服务可回退既有事件轮询，断线按游标续读，不重发用户输入。
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
- `POST /v1/runs/{id}/resume`：继续同一条带恢复记录的中断或失败回复。失败回复还需核验真实 checkpoint 属于该 run；已取消、没有 checkpoint 或会话已执行后续回复时拒绝。沿用原输入和步骤回执，旧版本缺失的模型快照仅补缺，运行前仍核对配置指纹与现有权限；无法确认副作用时继续走原批准流程，不自动重复写入。

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

- `GET /v1/resources/{UUID}/text`：认证读取校验过 SHA-256 的 UTF-8 文本原件，返回 `{resource_id,name,content,format:markdown|text,truncated,sha256}`；展示最多 128 Ki 字符。Markdown 在 App 内复用消息正文渲染，CSV/HTML 等作为可选择文本，拒绝不支持的二进制或编码；完整原件仍从 content 接口下载。
- 通用 `publish_report(filename,content)` 将 `.md/.txt/.csv` 保存为真实工作文件和不可变资源，并向当前根运行发出 artifact 回执；完成的助手消息携带该附件。单文件 UTF-8 最大 256 KiB，重复相同内容复用资源；虚拟 `write_file` 不代表已交付。

`Resource` 为 `{id,conversation_id,path,name,mime_type,size,sha256,created_at}`（列表另含 `seq`）。原件保存在服务数据目录，工作副本可以修改；消息和运行保存资源元数据快照。模型请求临时填充图片 base64，用户附件的 base64 不写入 checkpoint；`view_image` 的工具返回图片属于实际工具历史。

文件接口均需要服务令牌，拒绝目录穿越、链接和受保护文件；额外执行目录授权不扩大手机文件下载范围。

## 财务服务（v13）

金额使用非负 CNY 十进制字符串，统计由程序计算。以下接口均继承 `/v1` 认证，不依赖模型即可保存。

| 接口 | 输入或结果 |
| --- | --- |
| `GET /v1/finance/budget?month=YYYY-MM` | 有效预算；含 `month,source_month,recurring,revision,expected_income,savings_target,daily_budget,commitments,coverage_start,coverage_through` |
| `PUT /v1/finance/budget` | 完整设置：`month,idempotency_key,recurring`，可空的收入／结余／日常上限、承诺列表与覆盖期；可传 `expected_revision,expected_source_month` 防止覆盖刚发生的修改 |
| `PATCH /v1/finance/budget` | `month,idempotency_key,recurring,changes,expected_revision?,expected_source_month?`；按字段与承诺 key 更新，清空显式声明 |
| `DELETE /v1/finance/budget?month=&idempotency_key=&recurring=false` | 删除指定月份及沿用类型的配置，保留实际流水；返回 `{deleted:true}` |
| `GET /v1/finance/transactions?month=&limit=50&offset=0` | `{items:Transaction[],total}`，最大 100；按业务日期分页 |
| `POST /v1/finance/transactions` | `idempotency_key,kind,amount,occurred_on`，以及可选分类、关联、来源与覆盖字段；返回 Transaction |
| `POST /v1/finance/transactions/batch` | `idempotency_key,operations,conserve_total,reason`；同事务创建／纠正／删除并返回守恒校验，失败全部回滚 |
| `PATCH /v1/finance/transactions/{id}` | `idempotency_key,expected_revision?` 加待修改字段；原地纠正并推进 revision |
| `DELETE /v1/finance/transactions/{id}?idempotency_key=` | 软删除；存在关联退款时先处理退款，返回 `{deleted:true,id}` |
| `GET /v1/finance/summary?month=&as_of=YYYY-MM-DD` | `{month,budget,totals,reservations,remaining,projection,coverage,daily_average,record_count}` |

模型工具采用严格参数 schema，未知字段报错。已确认的既有资产提取不能记成新增收入；同用途预留的新 key 会返回已有项目供复用或显式替换，明确独立的项目可声明 `separate_from_keys`。这些有限语义检查不能取代核验原文与写后回读。AI 工具直接从绑定的真实输入验证日／月与同日起止的 range；`date_evidence` 是可选提示，不再要求重复原话。`date_source_message_id` 可选择已读取的历史用户消息，明确且唯一的实际日期可自动补齐。余额时点、覆盖月份或发薪规则不能证明消费日。不明历史保留范围，由助手查原文与处理，不新增用户填表步骤；手工 HTTP 的明确日期输入保持原样。

AI 新增或改变承诺的付款日同样需要真实用户付款规则依据，不能借用其他费用的日期；实际某次付款日、余额观察日和覆盖月份不能自动推成固定日期，未知日保留 null。已确认的同项目原付款日可继续沿用，手工 HTTP 不变。财务 Agent 在本次成功写入后仍由模型完成工具规划，纯记录和规则修改使用已核验保存值生成回执；当前真实用户同时要求建议、解释或比较时保留 AI 分析，并附独立的核验结果，不能用固定回执吞掉分析。报告和修改后的分析正文先缓冲，再随最终消息投影，思考与工具过程继续保留；未写入的普通分析对话继续使用原有流式正文。

处理中补充指令被图实际接收后，财务委派、默认日期依据、写入防重复键和报告交付统一继承该真实用户消息；尚未接收的排队指令和模型改写的委派描述不能替代它。同一消息的恢复仍重放原回执，新消息可继续使用同一业务 entry key。

原用户文字已明确已有资产提取时，AI 新建或改成收入还需对应的真实新增收入条款与金额，不能用模型备注中的“用户确认”代替事实，也不能靠删备注或改分类绕过。当前原文自动核验，可选 `fact_evidence`／`fact_source_message_id` 引用已读历史；批量操作放在每项顶层，不写入业务字段。该有限保护不把附件自动当作新缴存，也不为无文字提取矛盾的图片输入增加必填表单；手工 HTTP 仍沿用原服务校验。

纠正使用 `changes` 对象（兼容旧 `changes_json`，两者不能同时传）；放在顶层的 `amount` 不再被静默忽略。预算更新是字段 patch，省略保持现状，清空需 `clear_fields`；`commitments_upsert` 按 key 更新项目，`commitment_keys_remove` 显式移除。单月 patch 按字段继承后续沿用预算的修改。

`reconcile_finance_assets(start_date,end_date,opening_assets,closing_assets,approximate=true)` 只读已落账的已知流水，按相同资产范围计算期初加收入减净支出、预计期末及未解释差额。转账单列排除；部分相交的日期区间不猜分摊，累计和明细避免重复，近似余额与记录缺口随回执返回。报告引用程序公式，差额不自动变成消费或收入。

财务助手使用 `publish_finance_report(start_date?,end_date?,opening_assets?,closing_assets?,approximate=true,filename="财务回顾.md",period_evidence?,entry_key?)` 交付账本、预算及资产回顾。同一数据库快照生成事实正文和公式，再复用通用报告的文件、不可变资源、artifact 与手机预览链路；不接受模型自行拼写的数值正文。继续报告时，默认沿用同会话上一份已核验报告的范围和资产口径；只有实际当前用户明确指定新范围或更新余额才调整，模型参数不能自行缩成当月。无旧报告且省略日期时使用已知账本范围，期初、期末资产可成对省略，不要求用户补表。报告分别列月成本、到期现金与剩余预留，不推断未知消费或历史付款日；重复调用先校验并复用原交付回执，不修改财务记录。纯报告交付回复由核验事实生成；用户同时要求分析时，报告发布后只进行一次无工具的分析，保留建议和核验回执，避免继续循环计算。新指令、取消和未完成的操作仍按原流程处理。

AI 工具按显式 `date_precision=range|month` 与完整边界处理多余的单日提示，不改动手工 HTTP 的一致性校验。原话明确整体回顾范围时，没有本事件实际子期依据的缩窄范围由程序保留为整体时段；笔数、费用覆盖期和付款规则不授予缩窄权限。预算承诺的 `monthly_cost` 在工具层按实际付款额与周期核算；报告和批次每项兼容附带的 `entry_key` 标签，报告的真实回执及批次整体重放仍由程序控制。

`apply_finance_transaction_batch` 可将创建／纠正／删除作为同一事务执行；任一 revision 冲突或校验失败全部回滚。拆分需声明总额守恒，结果包含最终记录与校验信息，重试复用原回执。

`commitments` 每项为 `{key,label,amount,kind:fixed|one_time,every_months?,anchor_month?,due_day?,monthly_cost?,paid_through?,purpose?,separate_from_keys?}`。`amount` 是每次付款金额，周期按 `anchor_month` 和 `every_months` 推进；`monthly_cost` 是月度成本，默认用付款金额除以周期，`paid_through` 是已覆盖的最后月份。`recurring=true` 自该月沿用最近设置；单月配置优先。沿用时只保留固定承诺，不把某月大件继续预留到以后。`coverage_start/coverage_through` 必须同时提供且位于当月，只在用户确知记录覆盖时填写。PUT 是手动编辑的完整配置；模型使用上述 patch 工具，不把省略字段误清空。`income_schedule` 保存 `last_business_day` 或 `day_of_month` 规则，支持工作日和日期例外；仅周一到周五日历不代表法定调休或真实工资到账。

Transaction 另含 `date_precision:day|month|range,date_start,date_end,coverage_start,coverage_end`。未知具体日可给月份或日期范围，不默认写成今天；跨月区间在 `summary.unallocated.items` 中返回，不分配到某个单月。`coverage_start/coverage_end` 为此笔付款覆盖的 YYYY-MM 范围，与实际支付日期独立。

Transaction 包含 `id,revision,kind:expense|income|transfer|refund,amount,occurred_on,bucket:daily|fixed|one_time,category,note,commitment_key,related_transaction_id,entry_type:detail|aggregate,period_start,conversation_id,source_id,created_at,updated_at`。退款引用原消费并冲减其口径，不能超出原消费；转账与还款不再当消费。固定／大件付款以 `commitment_key` 抵扣对应预留。累计项给出同月 `period_start` 至 `occurred_on` 范围，与其覆盖明细衔接；累计范围不允许重叠。

`totals` 分列收入、净支出、日常／固定／一次性、退款与转账；`reservations` 为本月到期仍未付的承诺。`commitments.monthly_cost` 与 `cash_due` 分别列月成本和本月应付现金，不双重相加；历史付款覆盖期抵扣后续预留。`remaining.daily_budget` 同时受整体结余底线与独立日常上限约束，未知时为 null。`projection` 含预计与已收收入、剩余预计收入、费用／结余、`daily_basis,assumptions,reliable`；预计收入包含实收，不相加两次。`daily_average` 含 `amount,days,from,through,basis`，覆盖未知时不制造日均。`coverage.gaps` 与预测假设必须随结果解释，不把缺记录当零消费。

`commitments.items` 另含 `next_due_month:YYYY-MM,next_due_precision:day|month,next_due_on:string|null`。仅当承诺明确提供付款日时返回具体日期；未知日的付款保留月份，`next_due_on=null`，不以每月 1 日代替真实付款日。月内已归属收入不包含跨月未分配区间，不能据此断言实际没有到账。

## 健康服务（v12）

记录、规范、建议与实际摄入独立保存。健康列表返回 `{items:[...]}`，可传 `start/end=YYYY-MM-DD,limit=1..500`；summary 内的记录是直接数组。记录含 `id,revision,created_at,updated_at`，来源可附 `source_id,conversation_id`。

AI 记录入口允许省略未知的用餐／测量时刻，或只给已知 `YYYY-MM-DD`。程序使用系统绑定原用户消息的记录时钟并追加实际时间未知说明，保留已知日期；不会把餐次或示例时间当成实际时刻，也不要求用户补表单。已明确的实际时刻保持，局部修改保留未改时间与未知说明。HTTP 健康服务仍使用原显式 timestamp 格式；记录时钟不能作为实际发生时刻引用，手机端对未知时刻另作标注。份量只保存已说明的对应食物，不给其他菜补默认份数。

| 接口 | 输入或结果 |
| --- | --- |
| `GET /v1/health/summary?date=YYYY-MM-DD` | `{date,revision,profile,rules,all_rules,meals,recent_meals,weights,steps,recommendations,reminders,review}`；省略日期按提醒约定时区取当天 |
| `GET/PUT /v1/health/profile` | `revision,height_cm?,activity_limitations[],food_allergies[],food_exclusions[],preferences[],goals[],note`；未提供的身体数据保持未知 |
| `GET/POST /v1/health/rules`，`PUT/DELETE /v1/health/rules/{id}` | `content,kind:restriction|preference|guideline,status:active|paused|proposed,effective_from?,effective_until?,excluded_terms[],origin:user|professional|assistant_proposal,confirmed` |
| `GET/POST /v1/health/meals`，`PUT/DELETE /v1/health/meals/{id}` | `occurred_at,meal_type:breakfast|lunch|dinner|snack|other,description,portion,status:recorded|skipped,recommendation_id?,note,estimated_energy?` |
| `GET/POST /v1/health/weights`，`PUT/DELETE /v1/health/weights/{id}` | `measured_at,value,unit:kg|lb,note`；返回另含 `value_kg`，保留原单位 |
| `GET/POST /v1/health/steps`，`PUT/DELETE /v1/health/steps/{id}` | `measured_at,value` 非负整数、`note`；不自动生成运动目标 |
| `GET/POST /v1/health/recommendations` | `context_revision,target_date,meal_type,context,options[1..5],note`；保存时重新核对当前约定与记录 |
| `POST /v1/health/recommendations/{id}/feedback` | `id?,action:accepted|replaced|declined,option_id?,note`；采纳必须选择该建议的 option，困难保存在 note |
| `GET/PUT /v1/health/reminders` | `revision,enabled,timezone,slots[],quiet_start?,quiet_end?,max_per_day,paused_dates[],tone`；这里只保存偏好，不发送通知 |

POST 可提供稳定 `id`，同 ID 同内容重试不重复；相同来源经主／子 Agent 重试沿用条目标识。PUT 提供完整可编辑对象及当前 `revision`，DELETE 用 `?revision=`；并发修改返回 409 `revision_conflict`。档案／提醒 revision 从 0 开始。AI 工具对档案、提醒和记录纠正接受局部字段，事务内合并现状并自动读取省略的 revision；显式旧版本仍返回 409。工具端对设置、反馈、纠正和删除也保存原输入幂等回执，重放不会覆盖后来的新修改。

规范未给日期即持续沿用；前后日期相同表示只适用一天，`paused` 暂停，`proposed` 不进入有效规范。`assistant_proposal` 未确认时不能自动变为 active。能量估计为 `{minimum,maximum,basis,unit:kcal}`，必须有范围与依据，不能把照片当精确克数；skipped 必须由用户明确提供。漏记是未知，推荐与采纳均不增加摄入。

每个推荐 option 包含 `id,title,description,ingredients[],portion,substitutions[],reason,note`，可附有依据的 `estimated_energy,cost_note`。返回 `basis` 保存档案／规则修订及规则快照、食物与活动限制；`status:current|stale`、`latest_feedback` 区分新建议与历史选择。关键上下文变化、目标日期已过或生成期间修订变化时，旧候选过期／发布被拒绝（409 `stale_health_context`）。已知过敏与排除词进行成分字面匹配；有已知限制却缺成分返回 `ingredients_required`，冲突返回 `health_restriction_conflict`。这不是完整过敏原数据库，也不保证交叉接触安全。

`review` 包含已记／明确跳过餐次、覆盖说明、按有效测量形成的 `weight_trend`、`recent_choices`（含困难反馈与 `actual_meals`）及下一步上下文。多次同日称重不伪装成跨日趋势；纠正后用当前实际记录回顾，不自动降低摄入目标。

提醒 `timezone` 为 IANA 名称，slots 每项为 `{id,time:HH:mm,meal_type,kind:meal|review}`；安静时间须同时提供首尾，支持跨午夜，`paused_dates` 为当地日历日期。手机只排未来 14 天，按每日上限、暂停、已记录餐次和过期时间过滤；下次同步更新，不补发过期提醒。离线“今天不提醒这台手机”先保存在本机并取消当天通知，不冒充服务端偏好已更新。

## 同一顿的餐费与饮食

主知行的 `record_life_meal(entry_key,meal,amount?,occurred_on?,note?)` 通过 `LifeService` 在同一 SQLite 写事务保存两域及其幂等回执，返回 `event_id,atomic:true,finance,meal,payment_recorded`。金额缺失时只保存实际饮食，照片不推断餐费；任何一项失败均回滚。稳定条目标识来自原始消息，不随主／子路由或运行重试变化。

`query_life_events` 读取关联，`correct_life_meal(event_id,entry_key,meal_changes?,finance_changes?)` 同事务纠正原记录。修改共同日期时同时更新 `meal_changes.occurred_at` 与 `finance_changes.occurred_on`；不另建记录。它们是模型服务工具，当前没有另设 life HTTP 路由；手工表单分别通过对应财务／健康 HTTP 服务保存。

## 内部运行契约

代码在 `backend/src/zhixing_next`。config.py 负责配置，store.py 负责业务事务，api.py 负责 HTTP，
worker.py 负责调度与生命周期，runtime.py/models.py/tools.py 负责实际智能体与工具调用。
运行时提供 `search_personal_memories(query, offset=0)` 全库词法及明确人物称谓／昵称检索（每页 25 项与 `next_offset`）和 `read_personal_memory(memory_id)` 当前内容／来源读取；均为只读通用工具，遗忘运行中不开放，也不扩大指定来源研究助手的范围。有关系关联或歧义时，搜索回执额外提供 `recall_context: {facts,ambiguous_aliases,blocked_aliases,unresolved_pronoun}`；`facts` 为当前关联依据，不是新记忆，不能按歧义称谓选择某个人。用于唯一性、歧义和旧关系判断的依赖版本由服务内部登记，不发给模型。HTTP 记忆列表的字面子串查询协议保持不变。

未指明人物的单独喜好问句在模型菜单和执行层都先限制工具，仅向模型发送本轮真实输入来澄清；混合请求保留其他业务操作。代词只从本聊天真实用户已明确的人物继续，有唯一身份时仅允许定向个人记忆检索，顺序浏览和越到其他人物的查找受阻；Steer 会重新计算。新增明确关系导致旧称谓失去唯一性时，重置实际读过旧映射的会话模型上下文，原聊天不删除。

memory.py 在成功运行后整理用户确认的持久事实；整理按运行顺序进行，增删改与处理标记在同一 SQLite 事务提交。运行时带入最多四条／800 字全局交流偏好及少量相关事实和必要关系依据，均从当前 SQLite 事实派生，不另存画像；checkpoint 不充当长期记忆。主、直接及命名委派助手共享有边界上下文；指定来源研究助手保持原范围。纠正或遗忘也会使读取过派生称谓依据的会话失效；本轮运行恢复协议升级，不直接续跑旧协议暂停点。

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
模型 ID、思考档位和搜索服务 ID 在消息入队时写入运行记录，worker 按快照调用；LangGraph thread 以 conversation_id 标识，checkpoint 使用 data_dir 下独立 SQLite。worker 在运行开始时读取子智能体配置快照；主知行只委派已配置命名助手，主知行、直接子智能体和受委派助手复用同一通用工具装配：历史、个人记忆、资源库、当前附件、公开网页、计算、日期和报告交付；业务写工具仍按身份白名单提供。图片工具仍受模型 image_input 声明约束，搜索仅在本次选择服务时开放。搜索密钥只存服务端 SQLite，不进入消息、运行记录或 API 回执；联网结果是外部资料，回答应引用来源链接。
通用文件和网页错误返回受控 `error={code,message,next_action,retryable}`；参数字段错误只给出脱敏字段位置，不回显原输入、服务路径或 URL 凭据。保存资源的文本窗口支持 `char_offset`，返回 `next_start/next_char_offset` 以继续超长单行。工具执行取舍见[工具调用体验](TOOL-HARNESS.md)。

运行时发现原生 interrupt 后抛出 RunPaused，由 worker 保存等待状态并释放执行槽。恢复时复用同一 checkpoint 和步骤回执；模型/权限/助手/记忆重置/SDK 版本或助手基底提示词变化会拒绝旧恢复。旧版无恢复标记的运行仍保留 interrupted 行为，不宣称任意工具能自动安全续跑。

历史运行底座包含 `start_background_task`、`list_scheduled_tasks`、`schedule_task`、`set_schedule_enabled` 的实现；当前产品不向主知行提供这些创建／管理工具，旧计划在 v12 迁移中停用。它们不是手机远程通知接口。执行任务通过 DockerSandbox 接入 Deep Agents 的 execute/文件工具；`browser_action` 操作任务内 Chromium，`view_image` 查看实际图片，`publish_artifact` 校验并发布产物。主知行的 `copy_file` 在已授权文件目录间搬运最多 20 MiB 二进制文件。子智能体不自动获得 Shell、浏览器、调度或宿主目录挂载权限。


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

配置和凭据保存在服务端 `app.sqlite`；API 与 worker 按操作读取新配置。私有运行快照独立于公开运行记录，完成、取消及不可恢复失败后清除；带真实 checkpoint 的可恢复失败和中断任务保留。v9 现有 TOML 条目仅在迁移时导入一次，详见[升级说明](PROVIDER-MANAGEMENT.md)。

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
