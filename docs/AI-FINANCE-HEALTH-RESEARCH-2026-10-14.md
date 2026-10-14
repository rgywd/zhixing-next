# GitHub AI 财务与饮食体重管理调研

采样日期：2026-10-14，日期统一使用北京时间。取样目标是个人日常开支，以及通过聊天形成饮食约定、记录、推荐和持续跟进的健康服务。结论用于[产品文档](FINANCE-HEALTH-PRODUCT.md)和[实施方案](FINANCE-HEALTH-IMPLEMENTATION-PLAN.md)。

本次采样十三个项目，九个找到实际 AI 代码入口，四个传统工具作为较低优先级的对照。财务优先借鉴 Sure 的程序算账与工具契约、BeeCount 和 VeriFin 的中文输入与回执；健康优先借鉴 Fud AI 的记录与数据上下文，再参考 Luma 和 Oak 的回顾、跟进设计。知行继续沿用现有 Expo、Python 与 Deep Agents 架构。

## 采样与判断标准

优先级由需求契合度和实际 AI 路径决定。星数、README 功能清单和“使用 AI 开发”不作为产品 AI 能力证明。投资交易 Agent、企业报销平台和只有营销页面的项目不列为主要样本。

| 证据 | 可以说明什么 |
| --- | --- |
| README 与官方文档 | 项目声称的用途和接入方式 |
| 固定提交源码 | 实际注册了什么工具、哪些数据进入建议、是否存在写入或提醒路径 |
| 测试文件与对应提交 CI | 有哪些回归与远端运行结果，不能扩展成营养或模型准确率 |
| GitHub Release 与资产 | 存在发布版本或附件，不能扩展成已安装运行 |

本轮读取了公开仓库元数据、固定提交源码、测试、部分对应 CI 和发布信息，没有安装运行第三方应用，也没有验证真实模型识别、手机通知或营养估算准确率。“优先参考”指具体产品与工程行为，不代表可直接替换知行或已经完成使用验收。

## 财务样本

| 优先级 | 项目 | 已核实的 AI 能力 | 对知行的价值与边界 |
| --- | --- | --- | --- |
| 优先 | [Sure](https://github.com/we-promise/sure) | AI 调用预算查询、交易创建与分类路径 | 程序计算预算，模型解释；账本与聊天共用工具结果。Rails/PostgreSQL，不整体迁移 |
| 优先 | [BeeCount](https://github.com/TNT-Likely/BeeCount) | 文字、图片等抽取进入统一记账服务，Agent 调用与纠正 | 中文移动端输入、真实落库回执和部分失败处理；当前许可证有专门限制 |
| 优先 | [VeriFin](https://github.com/LumiDesk/verifin) | 自然语言生成记账草稿，AI 通过只读工具查询真实账本与预算 | AI 理解与确定性账本分工清晰；不能把只读分析 Agent 当可直接修改账本 |
| 补充 | [Flux](https://github.com/v11g/flux) | 实际使用 Deep Agents，工具支持预算创建、更新、查询 | Python 薄工具层最贴近知行；维护间隔较长，图片路径文本不等于视觉输入 |
| 降级参考 | [Finvo](https://github.com/kylesean/finvo) | LangGraph 对话记账、多模态入口、批量写入幂等 | 中文场景和栈贴合；预算实际仅查询，采样提交后端测试失败 |
| 传统对照 | [Actual](https://github.com/actualbudget/actual) | 本次核心路径采样未见内置 LLM 财务助手 | 只参考预算预留、跨月和窄屏交互，按非 AI 降级 |
| 传统对照 | [Firefly III](https://github.com/firefly-iii/firefly-iii) | 当前 README 明确 No AI | 只参考周期预算、固定开支和财务口径，按非 AI 降级 |

### Sure 的预算与写入契约

[预算工具](https://github.com/we-promise/sure/blob/a3bb5d991f9b96e335e9212b1a6324289577f143/app/models/assistant/function/get_budget.rb)返回服务端预算、实际支出、剩余额度及日均建议；[交易创建测试](https://github.com/we-promise/sure/blob/a3bb5d991f9b96e335e9212b1a6324289577f143/test/models/assistant/function/create_transaction_test.rb)覆盖幂等、账户范围、金额日期校验，以及写入后同步失败仍返回真实结果。

知行可借鉴同一应用服务同时供页面与 Agent 使用，避免模型心算和多个入口各算一遍。AI 依赖已配置的模型提供方；自托管数据库不意味着启用云模型后输入不出站。采样提交的[单元、系统与 lint 检查](https://github.com/we-promise/sure/actions/runs/38496771359)成功，不代表中文账单或中国支付渠道已验证。

### BeeCount 的中文移动输入与保存回执

[抽取引擎](https://github.com/TNT-Likely/BeeCount/blob/b09d1ec836f85a4b4519c2eaa0fbdd244c714d4d/lib/ai/core/ai_extraction_engine.dart)按文字、图片和音频类型调用对应模型；[记账服务](https://github.com/TNT-Likely/BeeCount/blob/b09d1ec836f85a4b4519c2eaa0fbdd244c714d4d/lib/services/ai/ai_bookkeeper.dart)返回实际成功记录 ID 和部分失败结果。[聊天测试](https://github.com/TNT-Likely/BeeCount/blob/b09d1ec836f85a4b4519c2eaa0fbdd244c714d4d/test/services/ai/ai_chat_service_test.dart)覆盖工具调用和权限场景。

值得借鉴的是统一入口、短回执、纠正与按实际写入结果更新界面。未知汇率按 1:1 暂记和输出完整 prompt 的调试方式不适合照搬。搜索中的 `shiqinghui/beecount` 是 fork，本文采用原仓；当前 [LICENSE](https://github.com/TNT-Likely/BeeCount/blob/b09d1ec836f85a4b4519c2eaa0fbdd244c714d4d/LICENSE)为自定义条款，不能沿用旧 MIT 描述。

### VeriFin 的中文问账与预算口径

[Agent 引擎](https://github.com/LumiDesk/verifin/blob/2bdf02fa956195d8025f8ef9da05afa34fc9f73e/lib/app/ai/ai_agent_engine.dart)实际支持原生工具调用与提示协议降级，并限制工具回合；[查询工具](https://github.com/LumiDesk/verifin/blob/2bdf02fa956195d8025f8ef9da05afa34fc9f73e/lib/app/ai/ai_query_tool.dart)包含分类排行、趋势、交易与预算状态。[记账解析](https://github.com/LumiDesk/verifin/blob/2bdf02fa956195d8025f8ef9da05afa34fc9f73e/lib/app/ai/ai_entry_parser.dart)输出草稿，与只读问账 Agent 分开。

知行可参考不同月份预算覆盖、确定性查询和协议错误处理。它的逐笔草稿确认不应变成知行所有清晰输入的门槛；Flutter 本地权威账本与知行服务端权威数据也不直接兼容。[引擎测试](https://github.com/LumiDesk/verifin/blob/2bdf02fa956195d8025f8ef9da05afa34fc9f73e/test/ai_agent_engine_test.dart)存在，本轮未执行。

### Flux 与 Finvo 的实现差异

Flux 的 [Agent 工厂](https://github.com/v11g/flux/blob/415c6ebdc208514dd8bbdbc831d565c94aaa1679/packages/agent-bot/src/flux_bot/agent/factory.py)实际使用 `create_deep_agent`；[预算工具](https://github.com/v11g/flux/blob/415c6ebdc208514dd8bbdbc831d565c94aaa1679/packages/agent-bot/src/flux_bot/tools/budgets.py)把身份绑定在服务端并使用 Decimal。适合借鉴有限工具调用，不引入其 Telegram/WhatsApp 与定时平台。采样提交的发布 workflow 通过，但较长维护间隔和当前 runner 仅拼接图片路径，降低其作为成品的优先级。

Finvo 的[交易工具](https://github.com/kylesean/finvo/blob/474fda1da6ea0f65cd8c97303a8301d945ce8dc2/server/app/core/langgraph/tools/transaction_tools.py)具备批量与消息幂等。[预算工具](https://github.com/kylesean/finvo/blob/474fda1da6ea0f65cd8c97303a8301d945ce8dc2/server/app/core/langgraph/tools/budget_tools.py)顶部描述创建和重平衡，实际仅注册查询，修改仍引导回 App。该提交的[后端测试失败](https://github.com/kylesean/finvo/actions/runs/35763679229/job/106867683501)，因此仅取设计参考。

### 传统财务对照的用途

Actual 的[封套预算实现](https://github.com/actualbudget/actual/blob/832f43da6c85e3c60878c667e5b793dd51fa39dc/packages/loot-core/src/server/budget/envelope.ts)和[移动预算测试](https://github.com/actualbudget/actual/blob/832f43da6c85e3c60878c667e5b793dd51fa39dc/packages/desktop-client/e2e/budget.mobile.test.ts)适合参考预留、跨月和窄屏。Firefly III 的[预算计算](https://github.com/firefly-iii/firefly-iii/blob/ba26768619842a4926655f315716f1b7788933d7/app/Support/Models/AvailableBudgetCalculator.php)适合参考固定安排与实际支出分离。二者不作为本次 AI 服务方案的主选，也不增设为知行的第二套账本。

## 饮食与体重样本

| 优先级 | 项目 | 已核实的 AI 能力 | 对知行的价值与边界 |
| --- | --- | --- | --- |
| 优先 | [Fud AI](https://github.com/apoorvdarshan/fud-ai) | 照片与文字饮食估算、纠正，Coach 读取档案和真实日志 | 移动端记录与有依据的建议；Coach 工具只读，部分提醒尚未接通 Android 设置 |
| 专题参考 | [Luma](https://github.com/d3mocide/Luma) | 餐食规划、持久聊天档案、缺记提醒与每周回顾任务 | 规范、记录和跟进的连接；心血管饮食导向，无正式 Release，周报存在静态疑点 |
| 专题参考 | [Oak](https://github.com/FrancescoCoding/Oak) | 营养 skill 读取个人资料，定时再次调用 Agent 并发消息 | 长期档案与主动回访；训练为主，缺完整饮食账本，外部服务和权限耦合较强 |
| 降级参考 | [NutriGuide AI](https://github.com/rjacaac211/nutriguide-ai) | LangGraph 真实工具、USDA 食物记录、档案与 RAG 建议 | 工具职责接近知行；每餐强制确认、无主动监督、未见许可证，采样部署步骤失败 |
| 传统对照 | [Waistline](https://github.com/davidhealey/waistline) | 核心路径采样未见 LLM 教练 | 只参考快捷食物、补记、体重趋势和备份 |
| 传统对照 | [wger](https://github.com/wger-project/wger) | 核心日志与计划采样未见营养 LLM 教练 | 只参考食材、份量、计划与实际记录的数据模型 |

### Fud AI 的记录与 Coach 边界

[ChatService](https://github.com/apoorvdarshan/fud-ai/blob/a1dd53b025d403c470a009116b4f8d9cc62669d5/android/app/src/main/java/com/apoorvdarshan/calorietracker/services/ai/ChatService.kt#L239)将档案、目标和测量用于建议；[CoachTools](https://github.com/apoorvdarshan/fud-ai/blob/a1dd53b025d403c470a009116b4f8d9cc62669d5/android/app/src/main/java/com/apoorvdarshan/calorietracker/services/ai/CoachTools.kt#L70)全为只读查询。饮食文字与图片走独立的 [FoodAnalysisService](https://github.com/apoorvdarshan/fud-ai/blob/a1dd53b025d403c470a009116b4f8d9cc62669d5/android/app/src/main/java/com/apoorvdarshan/calorietracker/services/ai/FoodAnalysisService.kt#L419)和 review，不等于在 Coach 聊天中直接保存每餐。

可借鉴缺记与明确空腹的区分、备注参与估算、用真实记录作建议依据。Android [NotificationService](https://github.com/apoorvdarshan/fud-ai/blob/a1dd53b025d403c470a009116b4f8d9cc62669d5/android/app/src/main/java/com/apoorvdarshan/calorietracker/services/NotificationService.kt#L37)表明部分总结提醒未接设置，不能按跨平台清单宣称齐全。采样的 [Quality workflow](https://github.com/apoorvdarshan/fud-ai/actions/runs/38537784784)成功且有 Android 安装资产；照片营养仍是估计。原生 Swift/Kotlin 与外部模型接入不直接移植。

### Luma 的档案与缺记跟进

[饮食规划](https://github.com/d3mocide/Luma/blob/bccedeb5dacd707896cde1b8a6f6d8f92ebbbfd8/backend/luma/agents/meal_planner.py#L55)读取目标、偏好与过敏信息；[聊天档案](https://github.com/d3mocide/Luma/blob/bccedeb5dacd707896cde1b8a6f6d8f92ebbbfd8/backend/luma/services/coach_context.py#L83)提供持久上下文；[worker](https://github.com/d3mocide/Luma/blob/bccedeb5dacd707896cde1b8a6f6d8f92ebbbfd8/backend/luma/worker/tasks.py#L105)按当地提醒时刻检查当天是否有餐食记录，并包含周回顾路径。

它的提醒检查的是当天有没有任意一餐，不能等同对每条饮食约定的监督。视觉 API 的固定 confidence 数字不代表校准准确率。周回顾 [SQL](https://github.com/d3mocide/Luma/blob/bccedeb5dacd707896cde1b8a6f6d8f92ebbbfd8/backend/luma/worker/tasks.py#L224)外层引用未由子查询导出的字段，静态看存在疑点，本轮未运行确认。适合借鉴档案与反馈关系，不照搬专病 prompt、模型估算值或复杂 TimescaleDB/Redis 结构。

### Oak 的长期教练与 NutriGuide 的工具

Oak 的[营养 skill](https://github.com/FrancescoCoding/Oak/blob/b2d321549ce3ac2a49d0259a039a90352befc034/coach-plugin/skills/nutrition-advice/SKILL.md)要求读取长期个人资料，再给份量与饮食建议；[scheduler](https://github.com/FrancescoCoding/Oak/blob/b2d321549ce3ac2a49d0259a039a90352befc034/src/scheduler/scheduler.ts#L95)真正调用 Agent 并发送消息。可借鉴有上下文的回访，但默认以训练和周计划为主，未见完整饮食主数据。[runner](https://github.com/FrancescoCoding/Oak/blob/b2d321549ce3ac2a49d0259a039a90352befc034/src/agent/runner.ts#L239)与 Claude、Telegram、Notion 及较宽工具权限耦合，不照搬权限模型。

NutriGuide 的[工具](https://github.com/rjacaac211/nutriguide-ai/blob/f5d213d85c6b424d33f9bb3917d1689f2a0d4737/ai-agent-ts/src/agent/tools.ts)确实读档案和近期记录，并通过 USDA 选择食物、按份量落库。[节点](https://github.com/rjacaac211/nutriguide-ai/blob/f5d213d85c6b424d33f9bb3917d1689f2a0d4737/ai-agent-ts/src/agent/nodes.ts#L393)在服务端覆盖模型提供的用户身份。借鉴职责和身份边界，但不沿用逐餐强制确认；未见主动监督或许可证。采样提交的[构建与部署 workflow](https://github.com/rjacaac211/nutriguide-ai/actions/runs/29933396050)整体失败，镜像构建推送成功，失败位于 [EC2 部署复制步骤](https://github.com/rjacaac211/nutriguide-ai/actions/runs/29933396050/job/88969071475)，不能据此认定源码无法构建。

### 传统健康对照的用途

Waistline 适合参考快速重复记录常吃食物、补记与趋势；wger 的[实际饮食日志](https://github.com/wger-project/wger/blob/da6405b6c066dd773f7acfff1b2cd774f1b4ecda/wger/nutrition/models/log.py)和[计划模型](https://github.com/wger-project/wger/blob/da6405b6c066dd773f7acfff1b2cd774f1b4ecda/wger/nutrition/models/plan.py)适合参考推荐与实际摄入分开保存。它们不替代“聊过规范后持续建议与跟进”的 AI 服务。

## 维护与许可证快照

下表是采样时默认分支最后提交日期及固定 SHA 前缀，不是最后发布日期。所有十三个样本采样时均未归档。许可证以采样提交为准；本轮未复制第三方代码，今后复用时按对应文件和数据许可核对。

| 项目 | 默认分支与提交 | 最后提交日期 | 许可证 | 发布状态 |
| --- | --- | --- | --- | --- |
| Sure | main `a3bb5d991f9b` | 2026-10-14 | AGPL-3.0 | [v0.7.5-hotfix.2](https://github.com/we-promise/sure/releases/tag/v0.7.5-hotfix.2)有安装资产，另有预发布 |
| BeeCount | main `b09d1ec836f8` | 2026-10-10 | 自定义条款，个人/研究免费，商业与修改另有要求 | [3.8.6](https://github.com/TNT-Likely/BeeCount/releases/tag/3.8.6)有 APK/AAB/IPA |
| VeriFin | main `2bdf02fa9561` | 2026-10-14 | GPL-3.0 | [v1.20.2](https://github.com/LumiDesk/verifin/releases/tag/v1.20.2)有 APK/AAB |
| Flux | main `415c6ebdc208` | 2026-04-28 | MIT | [v2.1.0](https://github.com/v11g/flux/releases/tag/v2.1.0)无附加安装资产 |
| Finvo | main `474fda1da6ea` | 2026-09-23 | AGPL-3.0 | [v0.3.0-alpha](https://github.com/kylesean/finvo/releases/tag/v0.3.0-alpha)为预发布 |
| Actual | master `832f43da6c85` | 2026-10-13 | MIT | [v26.10.0](https://github.com/actualbudget/actual/releases/tag/v26.10.0)有桌面产物 |
| Firefly III | main `ba2676861984` | 2026-10-12 | AGPL-3.0 | [v6.7.9](https://github.com/firefly-iii/firefly-iii/releases/tag/v6.7.9)有压缩包、签名与校验值 |
| Fud AI | main `a1dd53b025d4` | 2026-10-14 | MIT | [android-v7.2](https://github.com/apoorvdarshan/fud-ai/releases/tag/android-v7.2)有 APK/AAB |
| Luma | main `bccedeb5dacd` | 2026-09-17 | GPLv3 | 未见正式 Release |
| Oak | master `b2d321549ce3` | 2026-10-10 | MIT | [v1.1.0](https://github.com/FrancescoCoding/Oak/releases/tag/v1.1.0)为源码发布 |
| NutriGuide AI | main `f5d213d85c6b` | 2026-07-22 | 未见 LICENSE，API 无识别许可 | 未见正式 Release |
| Waistline | master `945fdd1af55b` | 2026-10-12 | GPLv3，已核 README 与许可文件 | [3.11.1](https://github.com/davidhealey/waistline/releases/tag/3.11.1)有 APK/AAB |
| wger | master `da6405b6c066` | 2026-10-14 | 应用 AGPL-3.0-or-later，数据和文档许可另列 | [2.7](https://github.com/wger-project/wger/releases/tag/2.7)无附加安装资产 |

## 对知行的方案取舍

这组样本分别覆盖记录、建议、预算或提醒，但不能据此认定某个项目已经满足知行的完整闭环。建议沿用现有架构，将已核实的具体行为组合为自己的服务：

1. 财务采用统一记录、自然纠正与真实回执；所有金额与预测由服务端计算，AI 解释与建议。预算、统计口径和目标可修改。
2. 健康采用“饮食约定、餐前建议、采纳或替换、实际记录、反馈回顾、调整约定”的连续关系，不止做热量计数加聊天页。
3. 餐费与饮食共享输入来源，主知行自动委派；各服务按实际写入结果回复，重试不重复。健康只使用必要餐费摘要。
4. 首版监督交付真实本机时段提醒，打开后使用最新记录给建议和回顾。服务器动态推送另列能力，不把保存了计划或缺记提示当作全天监督。
5. 数据不足时保留未知：缺记不等于没吃，照片不是精确营养测量，建议不等于执行，余额与估计日均不等于完整流水。
6. 完成记录、推荐、监督与独立安装后即发布，再依据实际使用决定是否增加银行、健康平台、完整食物库或远程推送。
