# DSH 上下文与会话统计

聊天输入栏在模型、思考深度和权限图标后增加上下文圆环。点击在按钮附近展开页面内 box，展示已用百分比、约计已用量／总容量、系统提示词、工具定义、对话消息，以及“压缩上下文”。日夜配色、窄屏和字号沿用共享 UI；点击外部或 Android 返回关闭，无原生 Modal 或底部抽屉。

每轮助手回复结束后显示两项紧凑读数：`x 轮 x 步 · x.x tok/s`、`xxxK/M tok · 缓存命中 xx%`。分别展开四行：模型用时、工具调用用时、TTFT、TPS；缓存命中率、未缓存输入、缓存读取、输出。数值是截至这轮结束的会话累计快照，后续回复不会更新旧快照；steer 将一轮拆成多个显示片段时只在最后一个片段展示。取消和失败使用其真实结束时的数据，fork 的合成结束不新增读数。

## 原生数据

对接 DSH 0.2.2-alpha.2 的 `sessionStats`、`tokenUsage`、`contextPressure`、`contextBreakdown`。上下文复用既有聊天轮询的原生投影读取，没有另加轮询、模型调用或实时流。优先显示 `projectedTokens`，回退 `pressureTokens`；总容量未提供时显示未知。三项构成采用宿主估算，不把分项强行加成供应商锚定的总量，进度条按构成比例分配已用段。

服务端只在读到原生 `turn/end` 时返回对应统计。历史读取通过原生 `sessionProjections.restore` 在同一事件截点生成原生投影，复用检查点向前读取；既不另写统计数据库，也不在手机上从可见消息重新计数。进程内最多缓存 24 个原生会话的可丢弃投影，重启可重建。App 按原生版本与结束事件 seq 合并缓存，翻页、离线恢复和版本切换不混用统计。旧 App 缓存首次升级会重新读取历史以补齐快照。

TTFT 为原生 `ttftMs / ttftSteps`；TPS 为 `decodeTokens / decodeMs × 1000`。Token 总量累加原生四个互斥桶，不再叠加 reasoning；命中率分母包含未缓存输入、缓存读和缓存写。宿主有缓存写入时在四行下方补一句计入总量的缓存写入量。缺失数据用 `—`，部分命中不四舍五入成 100%。原生字段语义见 [session-stats](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-stats) 和 [token-meter](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/llm/token-meter)。

## 压缩与输入

`POST /v1/conversations/{id}/dsh/compact` 仅接受 `{version}`，调用当前原生 Agent 实际提供的 `/compact` 命令。启动时验证当前版本，执行期间不持有消息入队锁。输入、steer、queue 和取消仍交给原生宿主，App 不建立第二条执行队列。压缩进行中仍可编辑和发送消息，空输入框显示停止；重复压缩及历史编辑／版本切换会被阻止。无需压缩返回真实 no-op；摘要失败或取消不返回成功；只有命令与持久化完成后回执成功。权限模式、模型与原生保留策略保持宿主语义。

快照增加 `statistics: [{seq,turn,stats,usage}]`（仅当前事件页的结束快照）、`context: {pressure,breakdown}`、`compaction: {available,running}`。旧服务缺少字段时不伪造值。冷会话只读统计不激活 Agent；用户点击压缩才按原生方式恢复。压缩接口在恢复后核验该 Agent 的命令能力，不接受任意命令字符串。

## 验证

本地类型、lint、移动端测试和插件测试；Android／iOS JS bundle；隔离真实 DSH 宿主验证快照逐项等于原生投影、尾页累计值、压缩摘要落库、新输入接收与继续、取消真实回执、版本绑定和重启恢复。Android 调试 App 连接隔离 DSH 宿主，验证三种锚定小窗、四行布局、外部点击／返回收起、压缩按钮的实际摘要回执及旧统计保持不变；另检查日夜主题、360 dp 窄屏和 1.3 倍系统字号。测试模型、JS 打包和模拟器不代表真实云模型、实体 Android 或原生 iOS 验收。此改动尚不属于已发布的 0.2.12。
