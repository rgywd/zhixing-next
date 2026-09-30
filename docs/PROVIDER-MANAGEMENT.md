# 供应商与模型管理

## 旧版 RikkaHub 的实现

本次核对的是同账号 `rgywd/zhixing` 的 `800492c7b9a5c1dfabe593b5818583270731d728`，不是根据截图推测。

| 层级 | 旧版实现 | 对 Next 的取舍 |
| --- | --- | --- |
| 供应商列表 | 搜索、拖动排序、推荐模板、自定义新增、扫码/文件导入；每个供应商有稳定 UUID | 先实现搜索、新增、编辑、启停和删除，同名供应商也按 ID 区分 |
| 供应商连接 | OpenAI / Google / Claude 类型分别保存地址、密钥、开关；OpenAI 可选 Responses、自定义请求路径 | 沿用已接入的 Chat Completions / Responses / Gemini；不添加没有执行链路的协议选项 |
| 供应商详情 | “配置 / 模型”两个页面；配置草稿显式保存 | 保留两页组织，放进现有带动画的底部弹层 |
| 模型发现 | 通过协议客户端读取远端列表，按 ID 排序；支持关键词交集搜索、批量添加/取消；也可手填 | 获取列表后选择导入；按同一供应商内的实际模型 ID 去重，不自动覆盖已编辑能力 |
| 模型元数据 | 内部 UUID 与实际 modelId 分开；显示名、模型类型、输入/输出模态、工具和思考能力 | 保留稳定内部 ID、实际 ID、显示名、图片输入、思考档位、温度、超时、启停 |
| 能力推断 | `ModelRegistry` 按模型名规则预填能力，之后可以手改 | 远端模型列表通常不包含能力证明，Next 不按名称猜测图片/思考能力，导入后按模型文档编辑 |
| 连通测试 | 针对选定模型分别测普通回复、流式回复、工具调用 | 相同三个检查，走实际 LangChain 客户端；工具探针只校验调用结构，不执行用户工具 |
| 默认模型 | 聊天、快速、标题、翻译、OCR、压缩等职责引用模型 UUID，收藏也按 UUID | Next 保持实际已有的聊天、执行、记忆整理三个职责 |
| 持久化 | 手机 DataStore 序列化供应商与模型，Compose 订阅设置流 | Next 的 API 和 worker 分进程，配置落服务端 SQLite；手机仅临时持有正在输入的密钥 |

源码入口：

- [供应商与模型的数据结构](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/ai/src/main/java/me/rerere/ai/provider/ProviderSetting.kt)，[模型元数据](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/ai/src/main/java/me/rerere/ai/provider/Model.kt)。
- [供应商列表](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/app/src/main/java/me/rerere/rikkahub/ui/pages/setting/SettingProviderPage.kt)，[详情、模型发现与编辑](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/app/src/main/java/me/rerere/rikkahub/ui/pages/setting/SettingProviderDetailPage.kt)。
- [三项连接测试](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/app/src/main/java/me/rerere/rikkahub/ui/pages/setting/components/ProviderConnectionTester.kt)，[默认模型分工](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/app/src/main/java/me/rerere/rikkahub/ui/pages/setting/SettingModelPage.kt)。
- [持久化与引用整理](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/app/src/main/java/me/rerere/rikkahub/data/datastore/PreferencesStore.kt)，[能力匹配规则](https://github.com/rgywd/zhixing/blob/800492c7b9a5c1dfabe593b5818583270731d728/ai/src/main/java/me/rerere/ai/registry/ModelRegistry.kt)。

本次没有迁移旧版的配置格式、手机密钥存储、Claude/Vertex 原生协议、图片生成/embedding 模型、二维码分享、余额查询、自定义请求头/请求体及单模型供应商覆盖。它们需要各自的真实执行能力，不能只复制设置控件。

## Next 的运行规则

设置 → 模型供应商 → 添加供应商 → 填协议、地址和密钥 → 模型 → 获取模型 / 手动添加 → 编辑能力 → 测试模型。随后在“默认模型”中选择用途，或直接在聊天中选用。

- 密钥通过已认证的服务接口提交，仅保存到服务端 `app.sqlite`。GET、错误回执和运行记录不返回密钥或环境变量名称。编辑时留空保留原密钥，清除使用独立开关；手机不缓存已提交密钥。
- 模型调用、发现与测试由服务端发起。远程地址要求 HTTPS；HTTP 仅允许服务端回环地址，用于本机模型服务。地址不能包含账号、密码、查询参数或锚点。
- 配置保存即对后续请求生效，API 与 worker 每次从数据库读取，不需要重启。修改使用 `revision` 防止旧表单覆盖另一处的更新。
- 删除/停用会清除失效的会话模型和默认引用，记忆角色未独立配置时仍跟随聊天。不会自动选择列表里的另一个供应商。聊天记录、任务及附件保留。
- 入队时在服务端私有表中保存模型、协议、地址、参数及当时的凭据。修改或删除供应商不改写已排队/在途/可恢复任务；普通运行接口不返回此快照。完成、失败或取消后删除对应私有快照；可恢复的中断任务继续保留，供显式恢复使用。数据库备份必须按凭据处理。
- 获取模型不等于验证模型能生成回复。发现接口限制 20 秒、每页 2 MiB、最多 10 页 / 2000 项；Gemini 分页并筛掉不支持生成内容的模型，截断显式告知。单次导入最多 200 个。
- 测试是显式操作，每项最多 15 秒、256 输出 token、无自动重试，可能产生少量费用；供应商错误正文不回传。通过不表示图片理解或全部思考档位均已验证。

接口对照：[OpenAI models](https://platform.openai.com/docs/api-reference/models)、[Gemini models](https://ai.google.dev/api/models)。Gemini 支持根地址或带版本的地址，SDK 调用避免重复拼接版本。

## 升级与回滚

数据库从 v9 升至 v10。第一次启动新版本时按名称、协议、地址与凭据环境变量将现有 TOML 模型分组导入，保留模型内部 ID 和角色引用，并为已有排队、在途和可恢复中断任务补私有快照。既有环境变量引用继续生效；手机替换密钥后该供应商使用数据库凭据。导入只执行一次，后续修改 TOML 不覆盖手机配置，也不复活已删除供应商。

升级前停止 API 和 worker，并一致性备份数据目录及工作目录。新旧版本不能同时读写 v10 数据库；旧版会拒绝该版本。回滚需要停服恢复升级前完整备份，不能只回退代码。

首次部署可以完全不写 `[models]`，从手机添加供应商和模型。路径权限、执行环境等系统配置仍通过 TOML 管理；修改这些配置或仍在使用的环境变量需要重启服务。

## 本次验收（2026-09-30）

- 本地回归覆盖认证、密钥不回显与留空保留、版本冲突、批量导入的事务回滚、跨供应商修改拒绝、启停/删除后的引用整理、v9 一次性迁移及重启持久化。API 和 worker 使用不同 Store 实例，验证配置更新无需重启，旧队列和恢复运行保持原始参数及凭据，终态清除私有快照。
- 三种协议通过真实 LangChain SDK 访问本地 HTTP 服务，实际解析 JSON、SSE 流和工具调用；Gemini 同时验证根地址和带 `/v1beta` 的地址。测试不只替换 `create_model` 或检查 HTTP 成功码。
- Android API 36 / Expo Go 中连接独立的本地后端，实际完成新增供应商、留空密钥保存、搜索并批量导入、编辑显示名/图片/思考能力、手动添加与删除模型、三项连接测试及聊天/执行默认选择；重开 App 后配置与默认选择保留。检查 411dp 浅色和 320dp 深色布局，以及输入密钥时的键盘避让。
- 交付检查：`npm run typecheck`、`npm run lint`、`npm run test:mobile`、Android / iOS JS bundle，以及后端 `uv run pytest -q`、`uv run ruff check .`。本次不修改 Docker 执行能力，未开启的 Docker 集成测试保持明确跳过。

以上使用独立测试数据库和合成凭据，没有更新云端生产数据库、读取或替换用户供应商密钥。本地协议服务通过不等于真实云端账号、额度、图片理解和全部思考档位验收；JS bundle 通过也不等于 APK 或 iOS 原生构建通过。
