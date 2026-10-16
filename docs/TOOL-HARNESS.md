# 工具调用体验：Codex、OpenCode 与 Pi 的取舍

2026-10-16。工具应让模型直接完成用户动作；来源、版本、权限和回执由执行层维护。函数能返回成功不等于真实模型能顺利调用，调用体验仍需真实模型评测。

## 官方参考

| 来源 | 核对结果 | 本仓应用 |
| --- | --- | --- |
| [Codex 工具指南](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)及[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) | 提供模型熟悉的工具名称、参数和输出；工具执行与沙箱、批准策略分开配置，失败结果回到执行循环 | 减少只为内部流程而存在的参数，已有权限和实际回执继续由 runtime 保证 |
| [OpenCode 工具说明](https://opencode.ai/docs/tools/)、[固定版本 read](https://github.com/anomalyco/opencode/blob/c5e513e98e2ea165035a34eb86e122a610c0431e/packages/core/src/tool/plugin/read.ts)与[edit](https://github.com/anomalyco/opencode/blob/c5e513e98e2ea165035a34eb86e122a610c0431e/packages/core/src/tool/plugin/edit.ts) | 读取以路径和可选窗口为主，权限集中检查；截断结果给继续位置，编辑对常见文本差异兼容并检查唯一匹配 | 默认参数可省略；输出必须说明怎么继续读、怎么修正失败，避免重复原样重试 |
| [Pi 固定版本 read](https://github.com/badlogic/pi-mono/blob/0fbdbd3f8ab1876ac260c0f08226a400759323b8/packages/coding-agent/src/core/tools/read.ts)与[edit](https://github.com/badlogic/pi-mono/blob/0fbdbd3f8ab1876ac260c0f08226a400759323b8/packages/coding-agent/src/core/tools/edit.ts) | 参数较少，分页提示明确；执行前兼容部分常见模型参数结构 | 常见格式问题由工具层处理，失败提供可执行建议；手机未开放的 Shell 不作为兜底建议 |

以上是对当前资料和源码的取舍，不引入上述项目的运行时、存储或权限配置。OpenCode 快照 c5e513e，Pi 快照 0fbdbd3。

## 当前修复

- 财务日期和报告范围直接从本次真实输入、已读取历史或上份已核验报告确定。`date_evidence`、`period_evidence` 是兼容提示，不再要求模型抄逐字原文。明确且唯一的实际日期可补齐，含混历史保持已知范围。
- AI 记账按显式日／月／范围精度规范化冗余日期字段，已知整体回顾范围中的不明历史保留整个时段，不能从笔数或费用覆盖期缩窄。月成本由付款额与周期计算。报告和批次接受常见的附带条目标识，实际幂等仍由程序维护；不因这些无害格式差异重复试错。
- 健康档案、提醒和纠正接受局部变更，在事务内合并现状并读取版本；省略字段保留。显式提交的旧版本仍返回冲突。HTTP 完整编辑接口保持原契约。
- 健康与财务共享实际输入绑定，新 Steer 和委派按当前已应用输入形成幂等键，不把新记录误判为初始输入的重试。
- 文件、文档与公开网页失败采用受控 `error={code,message,next_action,retryable}`。缺文件、错误 reader、类型、编码、大小、404、429等可区分；参数校验发生在文件授权规划前。未知异常不回显服务路径或凭据。
- 保存资源的长行支持 `next_start` 与 `next_char_offset`，截断后能完整继续读取。
- 财务与健康内置指令去掉重复格式门槛和过时要求。主、直接子 Agent 和委派子 Agent继续共用工具装配与回执机制。

账本口径、原子写入、过敏限制、路径授权和实际副作用核验由程序负责。一次失败不要求用户补表：模型先按回执修正或采用已有范围，只有真正阻止当前动作的信息歧义才追问。

## 验证与后续边界

针对性测试覆盖普通记账不传原话、健康单字段 patch、旧版本冲突、跨 Steer 幂等、真实 Deep Agents 图内错误后修正、文件授权与取消恢复。脚本模型证明执行链路；真实模型的首调成功率和纠错次数需要单独记录，不能用这些测试代替。

运行内子 Agent 的持续控制、跨独立对话投递与等待调度、健康／生活更完整的可见 schema 和独立调用体验评测由协作任务继续推进；本次不为这些后续能力建立空实现。
