# 模型思考适配

输入框的搜索与思考按钮使用透明背景，保留图标、状态点和文字颜色。欢迎页、普通聊天与财务聊天复用同一组件。

服务端 `reasoning.py` 根据实际模型 ID 匹配规则：忽略大小写，移除 `openai/`、`google/`、`moonshotai/` 等命名空间，兼容下划线。显示名称和供应商名称不影响判断。API 返回匹配后的档位与可选展示元数据，手机不自行猜测参数。已识别模型覆盖旧的通用档位列表；不再可用的旧默认档位退回模型默认。旧会话继承的无效档位在新输入入队时退回默认，已排队运行记录与模型快照不因此改写。

| 模型 | 选项 | 请求转换 |
| --- | --- | --- |
| Qwen3 混合思考、Qwen Plus/Flash/Turbo | 自动、关闭、低、中、高 | `enable_thinking`；预算分别为 1024 / 8192 / 16384 token |
| Qwen3 thinking | 自动、低、中、高 | 预算控制，不提供关闭 |
| Qwen3.8 Max / Flash | 自动、关闭、低、中、极高 | `enable_thinking` + `reasoning_effort`，均在 `extra_body`，不同时发送预算 |
| Qwen3.8 2.4T / 27B | 自动、低、中、极高 | `reasoning_effort`，不提供关闭 |
| DeepSeek V3.1 / V3.2、chat | 自动、关闭、开启 | `thinking.type` |
| DeepSeek V4、flash / pro | 自动、关闭、低、高、最高 | Chat 使用 `thinking.type` 与 `reasoning_effort`；Responses 使用 `reasoning.effort` |
| GPT-5 | 自动、极低、低、中、高 | `reasoning_effort`；Responses SDK 转成 `reasoning.effort` |
| GPT-5.1 / 5.2–5.6 | 按版本匹配关闭、低、中、高、极高、最高 | Pro、Codex 的可选档位另行限制；思考开启时移除温度 |
| GPT-6 | Responses 下按型号匹配 | Astra 不提供关闭；当前工具调用链要求 Responses |
| Gemini 2.5 Flash / Pro | 自动、低、中、高；Flash 可关闭 | 原生协议 `thinking_budget` 为 1024 / 8192 / 24576；关闭为 0；兼容协议用官方 `reasoning_effort` 映射 |
| Gemini 3 / 3.1–3.8 | 按版本匹配极低、低、中、高 | 原生 `thinking_level`；兼容协议 `reasoning_effort`。极低不承诺关闭，3.7 / 3.8 Flash 无极低档 |
| GLM 4.5 / 4.6 / 4.7、5 / 5.1 / 5.2 | 自动、关闭、开启 | `thinking.type` |
| Kimi K2.5 / K2.6 | 自动、关闭、开启 | `thinking.type`；即时模式温度 0.6，思考模式 1.0 |

已知固定思考或不支持思考控制的版本不提供调整：例如 Qwen Coder/Instruct、QwQ、DeepSeek reasoner、Kimi K2 Thinking、GLM 5.3、GPT-4o、Gemini 2.5 Flash Image。未知模型保留手工声明档位，未知 Gemini 继续使用原先的协议限制。规则覆盖的是已知名称；没有识别出具体版本的模型不代表已通过供应商验收。

“自动”省略思考参数，使用模型自身默认；“跟随模型默认”继承配置中的默认值，两者可不同。开关模型仍以既有 `high` wire 值保存“开启”，避免引入新的会话值。百炼 / QwenCloud 的第三方模型开关按已知域名改用 `enable_thinking`，不用供应商的可编辑名称判断协议方言。

Qwen 走流式请求，兼容只支持流式思考的版本。Qwen、DeepSeek、GLM、Kimi 的 `reasoning_content` 在普通与流式响应中保存在模型消息元数据，并原样回传后续工具调用；不混入用户可见答案。LangGraph SQLite checkpoint 保留此回执。Gemini 原生协议仍由其专用 SDK 保存 thought signature。

## 依据与验证边界

规则核对了 [Qwen 思考文档](https://docs.qwencloud.com/developer-guides/text-generation/thinking)、[DeepSeek 思考文档](https://api-docs.deepseek.com/guides/thinking_mode/)、[OpenAI GPT-5.2 文档](https://developers.openai.com/api/docs/models/gpt-5.2)、[Gemini 思考文档](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[Gemini 兼容协议](https://ai.google.dev/gemini-api/docs/openai)、[GLM 思考文档](https://docs.z.ai/guides/capabilities/thinking-mode)及 [Moonshot Kimi K2.5 模型说明](https://huggingface.co/moonshotai/Kimi-K2.5)。预算数字是知行选择的档位映射，不是供应商统一规定的“低 / 中 / 高”。

本地回归覆盖名称与版本规则、请求参数、API 目录到入队配置、旧偏好与队列快照、真实 LangChain 工具回合及 SQLite checkpoint、手机选项与标签。HTTP 测试使用 mock transport；这些结果不等于六家云端真实调用验收。Android / iOS JS bundle 不等于 APK、iOS 原生构建或真机运行。
