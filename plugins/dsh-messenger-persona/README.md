# TG 三月七人格

使用 DSH 原生 `deployment:persona-prefix` 槽位，仅为 Messenger Gateway 创建的 `msgw-` 会话加载[三月七人格](personas/march-seven.md)。当前云端只启用了 Telegram 出口；若以后启用同一网关的 Discord/Slack，它们也使用 `msgw-`，应先扩展渠道选择条件。App、普通 Web 会话和子 Agent 不注入。

人格与“鱼的记忆”分开：稳定性格保留在系统提示词，真实经历由已安装的 `dsh-fish-memory` 按会话保存和召回。没有新增记忆库、情绪随机数、定时任务或外部消息发送器。

另有会话专属 `zhixing:messenger-channel` 段，放在部署指导之后，区分角色背景和实际活动、约束闲聊长度。它与人格卡一起进入真实模型请求，不取代宿主的身份或工具规则。

## 加载

DSH 0.2.2-alpha.2 的原生 `agent/created` 是串行创建钩子，首轮模型请求之前即可挂载；插件激活时也处理已经存在的会话。按 Agent 实例管理清理，恢复同一会话的新实例会重新挂载。

每次组装读取人格文件，文件内容不变时系统前缀不变。更新文件后，同一会话的下一次模型请求生效，已经发给供应商的请求不会被追改。日常更新使用临时文件加原子替换；空文件、超出 24 KiB 或无效编码保留上一份有效人格并记录告警。第一次加载没有有效文件时明确失败。文本关闭模板插值，`{{…}}` 不会触发 DSH 变量解析。

通过 DSH 安装本包并设置 `ZHIXING_TG_PERSONA_FILE`，或者在宿主 patch 中直接挂载已验收源码：

```yaml
- insert:
    - id: zhixing-messenger-persona
      name: /opt/zhixing-next/plugins/dsh-messenger-persona/index.mjs
      config:
        personaFile: /etc/zhixing-next/personas/march-seven.md
```

第一次启用由宿主重新加载 patch；修改人格本身不用重启宿主。不要再把整份人设塞进网关 `agent.instructionPrefix`，也不要改第三方 `node_modules` 内的人格枚举。不要使用 `complete: true`，它会吞掉其他系统指导。

自定义安装目录的 DSH 配合“鱼的记忆”1.4.3 时，服务应设置 `DSH_HOST_MODULES=/opt/zhixing-next/runtimes/dsh-0.2.2-alpha.2/node_modules/@deepseek-ai`。否则它可能找不到宿主 `defineTool`，退回不兼容的参数格式，导致 DeepSeek 拒绝整个请求。该配置由宿主服务维护，不在插件中修改进程环境。

## 人格表达

保留三月七的明快、好奇、小小的好胜与摄影兴趣。闲聊按内容收短，认真任务正常展开；分享、倾诉、玩笑和交办分别回应，不强制每轮追问、emoji、语气词或“本姑娘”。角色背景与实际行动明确区分，真正的记忆和工具结果才能作为共同经历。

这次不新增会话外主动联系，也不自动接入 QQ/B 站账号。按需浏览、语音、表情包和定时跟进要由已有工具与真实配置支持。

## 验证

```sh
npm ci --prefix plugins/dsh-messenger-persona
npm run test:dsh
```

`tests/host-probe.mjs` 仅用于独立 DSH 验收宿主，不包含在包的 `files` 中。验证实际系统提示词、同会话热更新、错误回退、普通 Web/App 隔离、工具注册不被人格修改和恢复后的加载。工具注册与实际模型可调用的工具不同，不能从此检查推断网关全部任务工具可用。真实模型测试也在隔离宿主执行，不加载 TG 网关、不向用户聊天发送测试消息。

“鱼的记忆”1.4.3 的当前实现按会话隔离，并通过定时检查挂载到 Agent；本插件不修改其存储、检索算法或开关。网关重建会话后的长期连续性由网关会话绑定与记忆插件共同决定，不能把人格持久化等同于所有新会话共享记忆。

开源对照与实际验收见[调研与交付说明](../../docs/TG-PERSONA-2026-10-30.md)。
