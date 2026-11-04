# DSH 模型控制

设置 → 模型控制读取服务器的模型目录，选择知行默认模型和 Telegram 后台模型。沿用聊天里的模型选择器、搜索与收藏；缺少凭据的模型不可选。云端配置写入、回读成功后才更新选择，保存失败或版本冲突会重新读取服务器状态，用户可重试。每次打开或回到前台读取当前配置，不排队离线写入，不向手机返回供应商密钥。

模型名称和供应商没有客户端白名单。服务器新增并加载模型后，无需更新安装包：聊天页在线时约每 5 秒同步目录；模型控制页在打开、回到前台或点击“刷新云端模型”时读取。离线时无法发现新增项，恢复联网后再同步；模型缺少凭据时显示为暂不可用。

| 选择位置 | 生效范围 |
| --- | --- |
| 聊天页的模型选择 | 当前对话及从它创建的消息版本 |
| 设置 → 模型控制 → 知行默认模型 | 之后创建并开始的对话 |
| 设置 → 模型控制 → Telegram 后台模型 | 同一 TG 私聊接下来的回复、恢复会话和主动消息 |
| Telegram → 跟随知行默认 | 使用宿主当前默认模型 |

TG 切换保留会话、记忆、主动联系偏好与发送回执。正在处理消息时返回 409，不中断当前回复。兼容副本对只修改模型的配置更新保留原 Gateway 实例，避免重新连接 Telegram、重置轮询进度或丢弃待处理媒体。

## 原生接口

`GET /v1/settings/models` 返回 `default`、`telegram`。未安装对应服务时为 `null`；已安装时包含 `model_id`、`effective_model_id`、`writable` 和不透明 `revision`。TG 的 `model_id: null` 表示跟随默认。仅返回这些字段，不返回完整配置、令牌、联系人或文件路径。

`PUT /v1/settings/models` 接收 `{ key: "default" | "telegram", model_id, revision }`。模型标识沿用 `/v1/models` 的 JSON 编码 `[provider, model]`。通过原生目录与 `llm.resolveCallConfig` 验证可用性，再用 `settings.mutate` 修改 `agent-default-model` 或 `dsh-messenger-gateway.agent`；保留其他配置及秘密值。宿主重启会使旧的编辑版本失效。

App 对话模型使用原生 `agent.model.select` 并等待会话刷盘，与图片消息提交串行。原生 `sessionController.selectModel` 同时保存全局默认，所以 App 的单对话选择和历史分支不调用该方法。

## OpenAI

2026-11-04 已用账号目录和实际请求验证 `gpt-6-luna`、`gpt-6.1-terra`。使用 DSH 0.2.2-alpha.2 自带的 `llm-pi-ai` Responses 适配器，密钥仅保存在宿主 `.credentials.yaml` 的 `refs.ZHIXING_OPENAI_API_KEY`，权限 0600。App 接收模型名称、能力和选择结果。

在 `llm-pi-ai.providers` 增加如下配置，不替换已有供应商：

```yaml
openai:
  displayName: OpenAI
  api: openai-responses
  apiKeyEnv: ZHIXING_OPENAI_API_KEY
  baseURL: https://api.openai.com/v1
  transport: sse
  defaultMaxTokens: 128000
  models:
    - id: gpt-6-luna
      name: GPT-6 Luna
      input: [text, image]
      contextWindow: 1050000
      reasoningEfforts: {off: none, low: low, medium: medium, high: high, xhigh: xhigh, max: max}
    - id: gpt-6.1-terra
      name: GPT-6.1 Terra
      input: [text, image]
      contextWindow: 1050000
      reasoningEfforts: {off: none, low: low, medium: medium, high: high, xhigh: xhigh, max: max}
```

能力依据：[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)。上下文和图片能力是供应商声明；本次实际验证文本与工具调用。DSH 的 `off` 映射 OpenAI 的 `none`，手机显示“关闭”。

两个模型已通过 Responses 完成 DSH 原生 bash 调用、工具结果回传和最终回复。当前适配器未开放 OpenAI 托管 `web_search`、`file_search`、Code Interpreter 的附加工具配置；选择 Responses 不会自动增加这些工具。模型继续使用 DSH 已安装的工具与插件。

## 部署与验证

默认模型必须写在 profile 的 `cordis.patch.yml`，不能同时被 `--patch` 中的 `agent-default-model` 覆盖，否则原生编辑器会拒绝保存。迁移时保留当前默认值，从启动覆盖层移到 profile；不要改变既有会话的选择。TG Gateway 通过 profile bundle 加载，兼容副本由 `prepare-compat.py` 从校验过的 npm 0.4.23 / fish-memory 1.4.3 包生成，保留既有原生预设与记忆修正。

```sh
npm run typecheck
npm run lint
npm run test:mobile
npm run test:dsh
DSH_BIN=/绝对路径/dsh npm run test:dsh:integration
DSH_BIN=/绝对路径/dsh DSH_GATEWAY_PATH=/兼容副本/gateway/lib/index.js npm run test:dsh:models
```

最后一项使用真实宿主和 Gateway，但关闭 Telegram 网络；验证原会话实际使用的模型、跟随默认、闲置恢复、重启持久化和轮询实例不重建。可设置 `DSH_OPENAI_KEY_FILE` 追加两个模型的真实 Responses 工具回路，密钥读入独立宿主凭据，结束后删除临时凭据文件。插件依赖必须共享宿主原生模块，避免不同 Session 类副本混用。

部署前在隔离宿主验证，确认生产没有未完成的轮次后备份 profile、凭据、会话、业务、记忆与 TG 状态，再替换插件和配置。部署后分别核对健康、模型目录、配置读写和历史状态保留。App 客户端需要更新源码对应的安装包；服务端部署不等于客户端正式发布，实体 Android 与原生 iOS 另行验收。

2026-11-04 生产已部署 App 插件 0.5.0、TG 陪伴 0.1.2 和新的 Gateway 兼容副本，停机约 15 秒。服务器返回五个可用模型，两个 OpenAI 模型均为 Responses；原有 14 个原生会话、10 个 App 对话、记忆文件、业务数据、TG 绑定、偏好、发送回执和既有凭据均保留。TG 轮询无冲突、API 未降级。真实 OpenAI 工具回路在本机及云端的隔离宿主完成，未向真实 TG 发送测试消息。

Android API 36 ARM64 的独立 320dp 模拟器使用已有 development APK 容器加载本次源码，已通过“设置 → 模型控制”实际选择 Luna 默认模型和 Terra TG 模型，并核对原生宿主保存结果。截图与回执位于验收目录 `zhixing-model-controls-20261104`。新建开发 APK 遇到 Maven 依赖下载阻塞，离线构建也缺少对应缓存；此项未作为成功构建。Android/iOS JS bundle 已通过。以上为首次实现时的验证；后续正式包见 [0.2.14 发布说明](RELEASE-0.2.14.md)及对应 Release 构建回执。
