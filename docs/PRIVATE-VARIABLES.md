# 私密变量填写

模型调用 `zhixing_request_variables`，提供用途 `title` 和 `fields: [{name, label}]`，App 显示填写卡。一次 1–12 项，模型只提出名称和说明。名称为 `DSH_SECRET_` 加 1–80 个大写字母、数字或下划线（首字符须为字母），用户可以修改名称；每个值最多 32 KiB。

值只进入填写卡的临时状态，不进入聊天输入框、普通答案接口、消息、缓存或草稿。复用密码库原生屏幕隐私保护，成功启用后才允许输入；密码输入禁用自动填充与自动纠正，切到后台清空未提交内容。网络错误不显示服务器错误正文。失败可在前台重试，取消不保存。

`GET /v1/conversations/{id}/dsh` 的 `pending` 新增 `kind: environment`，只含请求 ID、所属会话、用途、字段和已配置变量名称。提交使用已认证的 `POST /v1/conversations/{id}/dsh/environment/{requestId}`，正文为 `{version, submissionId, fields: [{id, name, value, replace?}]}` 或 `{version, cancelled: true}`。跨会话、过期版本、已取消请求拒绝；所有字段先校验，再原子写入一个原生凭据记录。同名覆盖要求 `replace: true`。进程保留最近 256 个无值回执，支持丢失 ACK 重试；重启后以原生工具结果核对，失效填写请求不能重放。

存储使用 `credentials.modifyRecord`，记录地址为 `zhixing-app/environment-<工作目录摘要>`。本地提供方保存到 DSH_HOME 私有凭据文件（0600）；不另建工作区 `.env` 或 token 文件，不提供读取值的 HTTP 接口。重启重新加载，外部原生凭据修改刷新注入值。通过原生 `shellEnv` 向同一工作目录的后续 bash/pwsh 调用注入，不改变 `process.env`、手机环境、登录 shell 或已经运行的进程。可按程序要求映射名称，例如 `TELEGRAM_BOT_TOKEN="$DSH_SECRET_TELEGRAM_BOT_TOKEN" command`，无需把值展开进工具参数。

工具回传进入模型和会话日志前，若包含已保存值、JSON 转义、URL 编码或 Base64 形式，隐藏整个结果及其结构化值、错误元数据。阻止回传不撤销已经执行的命令，模型应核查非敏感状态，避免重复执行。沙盒、危险操作审批、取消和后台任务仍由 DSH 处理。

这保护输入和常见回传链路，不能隔离恶意执行程序。DSH 凭据文件与工具通常属于同一 OS 用户；完全访问的程序能读取环境或凭据文件，原生输出落盘、任意编码、文件交付及网络外传并非字符串检测能隔离。需要隔离不可信程序时，须采用专用凭据代理等安全边界。

随机测试值覆盖多字段、改名、覆盖、跨会话与失效请求、重试、失败、取消、真实 shell 消费值的 SHA-256、重启、0600 权限，以及原生 JSONL 与模型消息中无私密原值。不向生产凭据写入测试数据。
