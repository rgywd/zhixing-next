# 知行 DSH 插件

React Native App 是 DSH 的一个出口。插件提供移动 HTTP 接口及财务、健康业务工具；会话、执行、搜索、记忆和文件使用宿主及其插件。财务健康通过原生 `storageDomain` 持久保存，不需要 Python API/worker，不启动另一个 Agent 循环，不覆盖预设、工具集合、权限、轮数、预算或模型供应商。

对接版本：官方 [`@deepseek-ai/dsh@0.2.2-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3)。DSH 仍在 alpha 阶段，升级后需重跑原生集成验收。

## 启动

先按官方方式安装并配置 DSH 的 `web` profile，使默认模型和所需插件可用。需要 Node.js ≥ 24.9.0，且 `pnpm` 在 PATH 上（DSH 的插件安装命令会调用它）。保留宿主现有能力；本插件 patch 仅新增 `zhixing-app` 配置项。

```sh
npm install -g @deepseek-ai/dsh@0.2.2-alpha.2
dsh plugin --profile web add file:/绝对路径/zhixing-next/plugins/dsh-zhixing

export ZHIXING_DSH_TOKEN='替换为独立随机连接令牌'
export ZHIXING_DSH_PORT=8001
# 可选：让 App 能打开宿主配置页面。这里不填写带令牌的 URL。
export ZHIXING_DSH_WEB_URL='https://你的DSH地址/'

# 首次迁移可指定经核对的业务导出文件；新安装不需要。
# 只能导入空的原生业务域，同一个文件重启不会覆盖后来的变更。
export ZHIXING_DSH_BUSINESS_IMPORT='/私有目录/business.json'

# 从打算让 DSH 工作的仓库/工作目录启动。
dsh web --no-open
```

接口默认绑定 `127.0.0.1:8001`，通过现有 HTTPS 反向代理暴露给手机。在 App 的“连接服务”填代理地址及 `ZHIXING_DSH_TOKEN`。模型密钥仍在 DSH 宿主。需要改变监听地址时设置 `ZHIXING_DSH_HOST`。

本地 `file:` 安装会复制插件；修改源码后重新运行安装命令并重启宿主。DSH 包与插件依赖分离，不能把服务端依赖装进 Expo App。

## 接口与行为

- `/v1/status` 返回 `runtime: dsh`，App 使用统一的聊天布局渲染 DSH。当前 App 不再进入旧 Python 聊天路径。
- `/v1/conversations` 对应本出口创建的 DSH 会话，`/messages` 接收稳定的消息 `id`，以 DSH `requestId` 实现队列、steer 和重试去重。回执前 flush 原生会话日志。
- `/v1/conversations/:id/dsh?offset=N` 按原生 `seq` 读取事件，每页 256 条并返回下一位置；同时提供当前流式正文、队列与待回答问题。分页不限制执行长度或保留历史的总量。
- `/dsh/cancel` 调用原生 cancel，并等待 `whenIdle()`、持久化后回执。取消当前执行的语义沿用 DSH；独立后台 job 的生命周期仍由宿主 job 工具管理。
- `/dsh/queue/:itemId` 将 `remove`、`steer`、`edit` 交给原生 `updateQueue`，收到持久回执后刷新；队列来自原生 Session state，区分 queued／steering，过滤内部 context。
- `/dsh/answers/:id` 接回 DSH 请求的授权和提问。授权必须来自实际点击，不自动代答；过期请求拒绝，其他渠道的提问沿用其原答复链。已转为后续输入的 timed question 使用 DSH 原生继续回答接口。
- `/dsh/files` 将原始文件／图片流交给 DSH 附件服务，返回原生上传 receipt，随消息交给宿主处理。App 不沿用旧后端的 8 附件、20,000 字符文本或 20 MiB 上传上限；DSH 自己的模型、附件和传输规则仍生效。控制 JSON 请求体有 16 MiB 传输上限，大文件走流式上传。
- `/dsh/images/:attachmentId` 使用本对话持久消息中的图片引用，调用原生附件读取服务返回图片字节。需要连接认证，不能通过自传路径或别的会话引用读取图片。
- `/dsh/files/:attachmentId` 流式返回本对话的原生文件附件，`/text` 返回有限长度的文本预览；App 可预览和下载分享。文件归属与完整性由持久引用、DSH 附件服务共同核验，下载不套用旧业务 20 MiB 上限。
- `PUT /conversations/:id/title` 接回原生改名。`/conversations/search` 直接查本出口的持久会话正文，返回具体事件位置；不要求宿主启用可选搜索索引。精确语义见 [接口文档](../../docs/API.md)。
- 权限管理提供宿主的 `read-only`、`workspace-write`、`danger-full-access` 三种模式，调用原生 `/permission` 命令并核对持久回执；不修改全局默认值，不自建审批策略。快照返回所选版本的真实权限，新建会话可在首条消息前设置，旧消息编辑继承当前预设。接口见 [API](../../docs/API.md)。
- 模型目录、模型选择、默认 preset、取消和历史恢复直接使用 DSH 原生服务。任意工具的参数、结果和不认识的事件保留原始 JSON 可展开查看；专用交互式卡片可后续逐个补充。
- `/dsh/revisions` 实现真实历史编辑／重新回答，`/dsh/version` 选择继续使用的版本。逻辑对话 ID 不变，新版本使用原生历史前缀与宿主预设，旧记录不覆盖；编辑可修改文字、保留或移除原附件，编辑草稿独立保存，重试沿用同一请求。详情见 [API](../../docs/API.md)。
- 文件交付直接消费标准预设已有的 `present` 工具及 `deliverables/presented` 事件，不再注册 `zhixing_publish_file`。`/dsh/deliveries/:seq/:index[/text]?version=...` 只解析本逻辑对话的原生交付声明，再通过 `workspaceFiles.read/readBytes/stat` 读取；不接受客户端路径，不扩大宿主权限。沿用 DSH 的当前文件语义，文件改动后打开的是当前字节，删除或权限拒绝则真实报错。旧 `/dsh/artifacts` 快照接口与自建发布副本已移除。
- 当前对接版没有直接编辑／重答接口；适配层使用原生 `buildForkSeed` 和会话服务，补充逻辑对话的版本索引与请求去重，不新增 Agent 循环。消息下方按实际分支显示版本，切换不撤销工具或文件副作用。


插件始终为宿主注册 `zhixing_service`，可供其他出口复用。先读 `GET /v1/business/schema?domain=finance|health|life`，再调用财务、健康或联合餐费接口。App 直接读写同一数据；不维护独立业务服务。创建记录和联合餐费纠正的来源消息／会话编号由原生执行上下文自动带入，不让模型寻找内部编号。

`business/` 包含金额、预算、日期范围、健康事实和同餐付款的业务规则。`contracts.json` 在迁移时由旧输入模型导出，此后作为原生插件契约维护。串行操作在原生域的一个 durable commit 中完成；失败不发布半份数据，不伪造保存成功。新插件不注册记忆整理、资源索引、搜索供应商或人格心跳接口；需要这些能力时使用 DSH 插件。手机仍可上传照片／文件、预览和分享，但没有第二份资料库。

App 将原生记录整理成用户气泡和连续助手回复，复用 Markdown、思考／工具折叠、图片缩略图和全屏预览。工具详情优先显示文件名、正文、真实耗时、错误和已有修改前后片段；原生参数与原始结果在技术详情中；未知工具同样可读，不建立工具白名单。复制代码、选取文字和展开编辑复用知行主题，搜索可定位到命中消息。流式增长跟随最新消息，向上阅读暂停跟随；复制、引用／修改到草稿和处理记录放在消息操作中。排队消息用紧凑条展示，展开后可撤回或补充当前回复；发送方式在对话设置中选择。完整原生事件和未知插件数据仍可从处理记录查看。

照片、文件与文字持久草稿一起恢复；成功上传的 receipt 在提交前保存，回执丢失后的重试复用 receipt 和请求 ID。连接恢复只同步历史，不自动提交未发送草稿。

## 验证

```sh
npm ci --prefix plugins/dsh-zhixing
npm run test:dsh
DSH_BIN=/已安装的绝对路径/dsh npm run test:dsh:integration
```

集成脚本创建独立临时 `DSH_HOME` 和工作目录，启动完整 web profile，注入测试模型，验证真实 read → write → bash 检查、宿主工具保留、问题回答、队列引导／撤回、真实进程取消、宿主重启、去重、续聊、文件／图片上传、认证图片读取、原生文件下载预览、改名和搜索消息位置。同时验证财务健康原生存储、联合餐费原子写入、持久化重启和来源关联，不启动 Python 服务。不得指向生产数据进行验收。测试模型不证明云模型会自主完成代码维护。

## 当前边界

历史第二轮集成验证编辑后的真实模型输入、排队尾部不继承、新的重答结果、版本切换、图片／文件保留、重启后重试、过期／忙碌请求、发布快照与附件归属。Android 交付和详细边界见[第二轮记录](../../docs/AI-CHAT-REVISIONS-2026-10-29.md)。

本轮另外覆盖原生 present、当前文件预览／下载、宿主重启后的交付恢复与跨会话拒绝；真实 DeepSeek 对话和 Android 视觉验收见[重做记录](../../docs/AI-CHAT-REDESIGN-2026-10-29.md)。

新版本运行只需要 DSH；部署、原始数据核对和旧文件归档见 [业务迁移](../../docs/DSH-BUSINESS-MIGRATION.md)。旧 Python 源码保留用于历史参考与一次性对照测试，不是运行依赖。旧对话、记忆与任务可一次性归档为普通文件；不假装导入成原生聊天，也不自动重启暂停的任务或旧心跳。

DSH 原生能力由实际安装的插件与配置决定；本插件不保证未安装的记忆插件、未配置凭据的搜索供应商已经可用。模型密钥只在宿主；生产原生 Web 界面应沿用宿主认证，不能直接暴露未认证页面。签名发布、生产切换与真机验收各自记录，不能由测试模型、模拟器或构建成功推断。

对话菜单的删除使用原生归档并等待 Agent 空闲后保存知行移除标记（`zhixing_chat` v3，兼容 v1/v2）。原生会话与工作区文件仍由 DSH 保留；App 的读取、搜索、继续发送和版本切换不再暴露此对话。列表返回 `deleted_ids`，用于跨设备与缓存对齐。
