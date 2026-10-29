# 知行 DSH 插件

现有 React Native App 是 DSH 的一个出口。插件加 HTTP 接口、App 渲染与知行业务工具，运行使用宿主原生 Session Controller；不启动另一个 Agent 循环，不覆盖预设、工具集合、权限、轮数、预算或模型供应商。

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

# 可选：复用本仓 Python API 的业务数据。API 无需启动旧 AI worker。
export ZHIXING_BUSINESS_URL='http://127.0.0.1:8000'
export ZHIXING_BUSINESS_TOKEN='与该Python服务的API令牌一致'

# 从打算让 DSH 工作的仓库/工作目录启动。
dsh web --no-open
```

接口默认绑定 `127.0.0.1:8001`，通过现有 HTTPS 反向代理暴露给手机。在 App 的“连接服务”填代理地址及 `ZHIXING_DSH_TOKEN`。模型密钥仍在 DSH 宿主。需要改变监听地址时设置 `ZHIXING_DSH_HOST`。

本地 `file:` 安装会复制插件；修改源码后重新运行安装命令并重启宿主。DSH 包与插件依赖分离，不能把服务端依赖装进 Expo App。

## 接口与行为

- `/v1/status` 返回 `runtime: dsh`，App 保留当前导航壳子，选择 DSH 聊天渲染。旧 Python 地址仍走原有客户端路径。
- `/v1/conversations` 对应本出口创建的 DSH 会话，`/messages` 接收稳定的消息 `id`，以 DSH `requestId` 实现队列、steer 和重试去重。回执前 flush 原生会话日志。
- `/v1/conversations/:id/dsh?offset=N` 按原生 `seq` 读取事件，每页 256 条并返回下一位置；同时提供当前流式正文、队列与待回答问题。分页不限制执行长度或保留历史的总量。
- `/dsh/cancel` 调用原生 cancel，并等待 `whenIdle()`、持久化后回执。取消当前执行的语义沿用 DSH；独立后台 job 的生命周期仍由宿主 job 工具管理。
- `/dsh/queue/:itemId` 将 `remove`、`steer`、`edit` 交给原生 `updateQueue`，收到持久回执后刷新；队列来自原生 Session state，区分 queued／steering，过滤内部 context。
- `/dsh/answers/:id` 接回 DSH 请求的授权和提问。授权必须来自实际点击，不自动代答；过期请求拒绝，其他渠道的提问沿用其原答复链。已转为后续输入的 timed question 使用 DSH 原生继续回答接口。
- `/dsh/files` 将原始文件／图片流交给 DSH 附件服务，返回原生上传 receipt，随消息交给宿主处理。App 不沿用旧后端的 8 附件、20,000 字符文本或 20 MiB 上传上限；DSH 自己的模型、附件和传输规则仍生效。控制 JSON 请求体有 16 MiB 传输上限，大文件走流式上传。
- `/dsh/images/:attachmentId` 使用本对话持久消息中的图片引用，调用原生附件读取服务返回图片字节。需要连接认证，不能通过自传路径或别的会话引用读取图片。
- 模型目录、模型选择、默认 preset、取消和历史恢复直接使用 DSH 原生服务。任意工具的参数、结果和不认识的事件保留原始 JSON 可展开查看；专用交互式卡片可后续逐个补充。

设置业务服务后，插件为宿主增加 `zhixing_service` 工具，可供其他出口复用。先读 `GET /v1/business/schema`，再调用实际财务、健康、联合生活、记忆或资源接口。App 同一路由转发这些业务数据；桥接不会把 DSH 的模型请求送入旧 Deep Agents。业务路径检查只界定此工具操作的数据服务，完全不改变 DSH 其余工具的能力。

App 将原生记录整理成用户气泡和连续助手回复，复用 Markdown、思考／工具折叠、图片缩略图和全屏预览。流式增长跟随最新消息，向上阅读暂停跟随；复制、引用／修改到草稿和处理记录放在消息操作中。排队消息用紧凑条展示，展开后可撤回或补充当前回复；发送方式在对话设置中选择。完整原生事件和未知插件数据仍可从处理记录查看。

照片、文件与文字持久草稿一起恢复；成功上传的 receipt 在提交前保存，回执丢失后的重试复用 receipt 和请求 ID。连接恢复只同步历史，不自动提交未发送草稿。

## 验证

```sh
npm ci --prefix plugins/dsh-zhixing
npm run test:dsh
DSH_BIN=/已安装的绝对路径/dsh npm run test:dsh:integration
```

集成脚本创建独立临时 `DSH_HOME` 和工作目录，启动完整 web profile，注入测试模型，验证真实 read → write → bash 检查、宿主工具保留、问题回答、队列引导／撤回、真实进程取消、宿主重启、去重、续聊、文件／图片上传和认证图片读取。可用 `ZHIXING_TEST_BUSINESS_URL` 和 `ZHIXING_TEST_BUSINESS_TOKEN` 指向独立测试 Python 服务，验证真实业务桥接。不得指向生产数据进行验收。测试模型不证明云模型会自主完成代码维护。

## 当前边界

这是第一条可运行接入链路。未自动迁移旧聊天／运行状态到 DSH，也未迁移旧 worker 的人格成长、自动记忆整理、心跳或通知调度。旧业务数据仍在 Python SQLite，DSH 会话在宿主自己的持久层。原生 DSH 的能力可继续使用，App 已提供基础聊天展示，部分复杂产物和专用插件交互仍需打开宿主页面。Android 独立测试包的模拟器结果见[验收记录](../../docs/DSH-ACCEPTANCE-2026-10-29.md)；尚未部署生产、构建正式 APK/iOS 或完成真机验收。

下一段真实验收是：配置实际云模型，让知行在自身仓库的独立工作树里修复一个问题、运行本仓检查、产出可审查 PR。只有这段也完成后，才能称为“自己维护代码”的闭环。
