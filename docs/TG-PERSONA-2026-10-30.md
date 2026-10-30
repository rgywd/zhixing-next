# 云端 TG 人格与加载方式

2026-10-30。目标是完善现有 `MarchSeventh_bot` 的三月七人格，参考 QQ/B 站“大肥鱼”的自然互动方式。

## 现状与修复

实际环境为 DSH 0.2.2-alpha.2、Messenger Gateway 0.4.23、鱼的记忆 1.4.3。正式网关已在线；旧人格文件和 `system-prompt.personaPrefix` 只存在于 `.trial`，正式 profile 的 `instructionPrefix` 为空、没有对应人格配置。试验环境成功不等于正式加载。

新增[专用加载器](../plugins/dsh-messenger-persona/README.md)，通过宿主原生系统人格段按会话注入。人格文件热更新，保留最近有效版本；不覆盖全局人格、不修改网关源码、不把人设反复混进用户消息。身份与语气保持稳定，真实经历交给已有记忆插件。

人格卡与聊天环境约束分成两个会话专属段：前者描述稳定性格和相处方式，后者区分角色背景与实际活动。使用少量接话示例约束闲聊，不要求每条回复都玩梗、追问或刻意错字。明确要求长期保留的称呼、偏好使用现有 `remember` 的常驻层，纠正沿用事实键并替代旧说法。

隔离环境的真实模型测试还发现“鱼的记忆”在自定义 DSH 安装路径下找不到 `defineTool`，回退参数格式导致供应商拒绝请求。宿主服务补充 `DSH_HOST_MODULES` 指向实际 `@deepseek-ai` 目录后，记忆调用正常。未修改第三方插件源码。

## 开源项目对照

下表是本次阅读公开 README、人格文本和当前云端源码后的工程判断，不是对这些项目的运行验收。

| 项目 | 许可证/定位 | 可借鉴之处与取舍 |
| --- | --- | --- |
| [whyever77/dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot) | MIT；AstrBot + QQ 的角色与插件组合 | 提供完整人格文本、短对话节奏、少口癖、真实记忆和工具回执约定。其 QQ、手机控制、语音等配置不能直接当成 TG 已有能力。 |
| [nanbengxian-cyber/dafeiyu-qq-bot](https://github.com/nanbengxian-cyber/dafeiyu-qq-bot) | QQ 群聊工程，README 列出 59 个插件及另一条 DSH 桥接路线 | 值得参考口癖与延迟的实测方法。大量独立状态和注入也有协调成本；不整体移植，不用故意错字制造人感。 |
| [yyh-001/dsh-companion](https://github.com/yyh-001/dsh-companion) | MIT；DSH 人格、文件记忆与可选 QQ | 稳定 SOUL 和真实经历分层很合适。但 README 说明记忆文件跨会话共享、QQ 出口仍是最近目标 MVP，不能直接替换现有 TG 与按会话隔离的记忆。其 README 槽位名与当前 0.2.2 的 `deployment:persona-prefix` 也需按实际版本核对。 |
| [Aliuyanfeng/dsh-soul](https://github.com/Aliuyanfeng/dsh-soul) | MIT；DSH 可视化人格、预设与作用域 | 适合需要网页管理多套人格的场景；支持全局、工作区、会话层级。本次只修一个现有 TG 人格，复用宿主槽位更小。 |
| [MaiBot](https://docs.maibot.chat/en/about/) | GPL-3.0；自然群聊 Agent | 对话长短、是否插话和如何接话的设计可参考；它是另一套运行体系，不为这次 TG 人格替换 DSH。 |
| [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | MIT；DSH B 站阅读与日报插件 | 提供真实浏览内容，能形成可分享的话题；它本身不是人格。本次未安装或授权 B 站自动互动。 |

因此这轮采用“稳定角色 + 场景化表达 + 真实记忆 + 宿主工具”的组合。新人格为三月七重新编写，只借鉴设计方法，没有复制上述项目的插件代码或角色段落。

## 验证边界

2026-10-30 19:34（北京时间）已启用云端独立人格插件。人格文件位于 `/etc/zhixing-next/personas/march-seven.md`，加载器位于 `/opt/zhixing-next/plugins/dsh-messenger-persona/`；宿主 patch 增加该插件，systemd drop-in 配置记忆插件的宿主模块目录。变更前确认 App 和 TG 没有未结束的回合，并保存原配置到 `/var/backups/zhixing-next/tg-persona-20261030T113432Z`。

部署后 App 的模型、worker、执行与业务连接状态正常；TG 适配器在线，轮询无冲突、API 失败计数为零。部署文件与最终本地源码逐项核对 SHA-256。此为云端 TG 独立插件及配置变更，未创建 App 正式版本或发布标签。

本地单元回归覆盖文件替换、无效文件回退、启动失败、渠道筛选、子 Agent 排除、重复挂载与卸载。最终独立 DSH 的 11 项加载断言通过；同时读取真实会话日志中的 `system/message`，确认实际模型请求包含人格卡、聊天环境规则和记忆提示。普通 Web/App 未注入人格，热更新未改变工具注册。

真实 DeepSeek Flash 共完成 18 轮对话，覆盖倾诉、闲聊、显式记忆、称呼纠正、AI 身份、视频能力和晚安。过程中发现过虚构相册/收拾桌子的回复，随后增加明确的短句示例；最终 3 轮问候、追问日常及身份回答未再出现这些行为。这是小样本改善，不代表能消除所有幻觉。稳定称呼和茶偏好已实际写入 `stable_profile`；恢复同一个原生会话后能召回，纠正后旧称呼被替代。

发现一项现有网关限制：其会话创建未按 App 路径挂载完整原生 preset。测试中“用工具计算”的请求只做了文本计算，不能据此声称 TG 的 Shell/文件等任务工具已验收。本次人格插件不扩大工具或审批权限；App 的原生工具、文件、队列、取消、恢复、问题、业务与审批路径另跑完整集成回归通过。

没有向真实 TG 聊天发送测试消息，未验收手机端排版、跨日主动联系或网关创建全新会话后的记忆连续性。现有记忆按会话隔离，网关重新绑定会话的问题不由人格文件解决。本次未安装 B 站自动浏览、QQ 或新的定时发送能力。
