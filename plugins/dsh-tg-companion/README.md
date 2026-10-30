# TG 持续陪伴

让指定用户的 Telegram 私聊在进程重启、闲置回收和 `/new` 后保留连续性，并在合适的时候主动分享一个话题。人格继续由 `dsh-messenger-persona` 热加载，记忆继续由 `dsh-fish-memory` 管理；不新增另一份人物资料库或旧 Python 运行依赖。

## 行为

- 同一私聊的原生 session ID 持久保存，重启或回收后通过 DSH `agents.resume` 恢复，保留消息、工具结果和原生预设。
- `/new` 创建新的原生会话，仍使用这位用户的同一份鱼的记忆。旧话题可用仅本人会话可见的 `companion_history` 查找；当前纠正和遗忘优先于历史原话。
- App、群聊、其他联系人及子 Agent 不共享这份私聊记忆，也不获得陪伴工具。
- 用户确认的默认值：北京时间 **10:00–22:00，每天最多 2 次**。距用户聊天至少 90 分钟，两条主动消息至少相隔 4 小时；一条没回复就不继续追发。上限不是每日任务数。
- 每 5 分钟仅检查资格；符合条件时最多每 2 小时取材和判断一次。没有值得分享的内容则安静。新闻只读取最近 72 小时的 NASA、GitHub 官方 RSS，带真实日期和原文链接，不浏览 B 站。
- 可以直接说“先别主动找我了”“恢复主动聊天吧”。更复杂的设置由原生模型调用 `companion_contact`，例如“少发一点”“每天最多两次”，保存成功后再确认。
- 主动草稿是一次没有工具的模型请求，仅用于选话题。用户正常聊天仍沿用宿主模型、原生工具和审批规则。

## 持久性与发送

私聊绑定、偏好、检查时间和投递记录在 `$DSH_HOME/zhixing-tg-companion/contact.json`，通过临时文件、文件与目录 fsync、原子替换保存。目录 0700、文件 0600；文件损坏时停止启用，不重置成一份空账本继续发消息。

发消息前先持久记录 `sending`，只执行一次 Telegram `sendMessage`，取得真正的 `message_id` 才记录 `sent`。超时、无回执或中途退出留下 `unknown`/`sending`，不自动重试、不冒充发送成功，也计入频率与未回复限制。收到用户新消息的序号用于确认回复，不依赖毫秒时间恰好不同。

确认发送的文字及回执进入原生插件记录，并在下一轮私聊的专属系统段提供给模型，让它能接住用户对主动消息的回复；不伪造一轮用户消息或助手推理。

## 加载与兼容

适配 DSH **0.2.2-alpha.2**、部署中的 Messenger Gateway **0.4.23**（含既有预设修正）和鱼的记忆 **1.4.3**。`prepare-compat.py` 先校验实际部署源码 SHA-256，再生成保留许可证的依赖副本。源版本不同必须重新审查，脚本拒绝猜测补丁位置；不会修改已安装的 `node_modules`。

兼容副本只补四个入口：网关连接陪伴服务、记录本人私聊活动、为该私聊恢复原生会话、把其记忆读写/删除/备份映射到同一 canonical store。鱼的记忆增加原生 Agent 创建时的立即挂载，避免首轮只等轮询。原有去重、纠正、删除记录及 purge epoch 都沿用同一写入者。

```sh
python3 plugins/dsh-tg-companion/prepare-compat.py \
  --modules /path/to/profile/node_modules \
  --output /path/to/new-versioned-compat \
  --host-modules /path/to/native-runtime/node_modules
```

用 profile 当前的包管理器把这两个已安装依赖切换为兼容副本的本地 `link:` 依赖，保留 `dsh.profile.bundles`、原插件 ID 与全部既有配置。这样服务端、浏览器模块和设置 namespace 都指向同一个包，不会启动两套写入者。生产先完整备份 profile，在同级临时 profile 中用原服务账号准备依赖，核对原配置和包的读取权限后，再在空闲时短暂停服切换目录：

```sh
# 在同级临时 profile 执行，沿用当前 profile 的 pnpm 版本和宿主 peer 策略。
pnpm add --ignore-scripts --config.auto-install-peers=false \
  @goodandready/dsh-messenger-gateway@link:/path/to/new-versioned-compat/gateway \
  dsh-fish-memory@link:/path/to/new-versioned-compat/fish-memory
```

校验元数据完整缓存时可以加 `--offline`；缺少缓存时由包管理器正常取得公开元数据并执行原有安全校验。构建副本仅含公开包文件，目录 0755、文件 0644，不能因操作员的私有 umask 使服务账号无法读取。

另在宿主 patch 中增加陪伴插件：

```yaml
- insert:
    - id: zhixing-tg-companion
      name: /opt/zhixing-next/plugins/dsh-tg-companion/index.mjs
      config:
        targetUserId: !!js Number(process.env.ZHIXING_TG_OWNER_ID)
        # 仅在确认属于这位用户时填写；未提供则首次创建。
        # seedSessionId: msgw-verified-existing-session
```

注意：DSH 0.2.2 的 ID 补丁中 `name` 是匹配校验，**不能用来替换模块来源**；不同名称会使整个补丁被跳过。不要使用这种看似成功的覆盖方式，也不要禁用旧 ID 后换一个 ID，网关的设置页面依赖原 namespace。

`seedSessionId` 仅用于第一次建账，不覆盖已有状态。部署只可迁入已核实归属的 TG 私聊，不扫描并合并其他来源。私聊目标与网关 `allowedUserIds` 均须有效，群聊/话题 ID 不适用。保留宿主 `DSH_HOST_MODULES` 的实际原生模块目录。

## 验证与回滚

`npm run test:dsh` 覆盖重启、跨日时段、两次上限、并发、生成期间新消息/暂停、跨到静默时段、发送前/后的落盘失败、无回执去重、话题去重与 RSS 日期/域名约束。

`tests/integration-host.mjs` 是不包含在发布包内的隔离验收探针：原生宿主、真实模型、真实记忆插件及兼容网关类，使用合成联系人和本地 Telegram 回执，不加载生产 TG 凭据。它也可读取真实公开新闻。凭据、控制 token、个人日志均保存在仓库外。

回滚时恢复完整 profile（包括 manifest、锁文件和原依赖链接）及宿主 patch，重启 DSH。保留新增私聊状态、原生日志及记忆供恢复，不删除新产生的用户数据；不要复原旧空投递账本，否则可能重复发送。实际测试与生产状态见[交付记录](../../docs/TG-CONTINUITY-2026-10-30.md)。
