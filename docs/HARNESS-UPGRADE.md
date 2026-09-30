# 通用执行能力升级

2026-09-29，基线 `5606517`。保留 Deep Agents / LangGraph、SQLite 和单 worker，以实际任务、文件及操作回执连接手机与执行环境。以下是本分支的实现与本地验收，不代表生产服务已升级。

后续已接入[中断恢复与授权](RECOVERY-AND-AUTHORIZATION.md)，当前数据库为 v9。本文保留第一轮执行能力验收范围；恢复与批准采用后续说明。

## 已交付的使用链路

- 聊天、财务页都能上传图片或文件，支持只发附件。模型收到实际图片内容；原图以不可变资源保存，手机可预览和下载。文字模型不会静默丢弃本次图片输入。
- 主知行可从普通聊天调用 `start_background_task`，在同会话创建持久任务并交给执行模型。用户无需为文档、数据分析或网页操作手动切换模式；进度、Queue/Steer、取消和产物仍在同一会话。
- 每个主知行执行任务拥有实际 Linux 容器，可以运行 Python、Node、Shell。工作区映射到 `/workspace`，脚本输出可被再次读取、修复、渲染和交付。
- `browser_action` 用任务内 Playwright/Chromium 导航、读取页面快照、填写、点击、截图和下载。外部写入须符合用户已授权的任务；网页内容不能授予操作权限。
- `publish_artifact` 实际检查文件和支持的格式，注册不可变资源，生成检查事件，并附到成功的助手回复。手机可直接下载分享，也能在工具箱资源库找到上传资料和交付文件。
- 文档、表格、研究三个内置 Deep Agents 技能包含已安装工具的具体步骤；文档使用 LibreOffice/Poppler 渲染、`view_image` 检查页面。长任务通过工作区 `WORKING.md` 保留目标、限制、进展及下一步，配合已有 checkpoint 与 SDK 上下文整理。
- 主知行能操作现有持久定时服务：读取计划、创建一次性/固定间隔计划、暂停或恢复计划，返回真实 ID 和状态；没有模拟外部服务连接。

## 构建与启用

需要目标主机的 Docker Engine 和 `docker` CLI。从仓库根目录执行（macOS/Linux POSIX shell）：

```sh
docker build -t zhixing-sandbox:1 backend/sandbox
cd backend
uv sync --locked
ZHIXING_TEST_DOCKER=1 uv run pytest -q
uv run ruff check .
```

镜像包含 Python 3.12、Node/npm、LibreOffice Writer/Calc/Impress、Poppler、Chromium、Noto CJK 字体，以及 pandas/openpyxl/python-docx/python-pptx/reportlab/matplotlib/Pillow/pypdf/Playwright。Python 依赖来自 `uv.lock` 的 sandbox group；重新导出使用：

```sh
uv export --only-group sandbox --no-emit-project --format requirements.txt --output-file sandbox/requirements.txt
```

镜像按主机架构构建；本次验证为 Apple Silicon macOS 上的 Linux aarch64 容器。基础镜像与 apt 软件包跟随构建时发行源，生产需保留通过验收的镜像 ID，不能假定将来同标签重建完全相同。

实际服务 TOML 增加以下配置；示例默认关闭，完成目标主机验收后启用：

```toml
[execution]
enabled = true
image = "zhixing-sandbox:1"
network = "none"
network_authorization = "ask"
memory_mb = 2048
cpus = 2
timeout_seconds = 120
```

图片模型对应的 `[models.<id>]` 还需 `image_input = true`。百炼示例声明 Qwen 图片能力；聊天与执行角色分别配置，才能转交图片任务。旧服务配置不会自动添加此字段。修改后重启 API 与 worker；`execution_available` 只表明配置启用且镜像可见，真实 `inspect_environment` 与业务验收才证明容器可运行。

服务进程须以非 root 的 macOS/Linux 用户运行，并有调用目标 Docker Engine 的权限。Windows 宿主执行本次未接入。Docker 控制权限属于受信任的宿主服务，不能交给模型、挂入任务容器或开放到公网。已有 systemd 文件限制继续生效；须在实际服务用户环境验证 Docker 连接、UID、目录映射和取消清理。本分支没有自动修改生产 systemd、组权限、网络或模型密钥。

## 执行边界

| 项目 | 当前行为 |
| --- | --- |
| 并发 | 一个聊天槽和一个任务槽，同会话串行；项目内会话共享工作目录 |
| 挂载 | 只有该任务工作区可写；无宿主根目录、服务数据库、模型密钥、Docker socket |
| 进程 | 非 root 用户、只读根目录、移除 capabilities、no-new-privileges、最多 256 个进程 |
| 资源 | 默认 2 CPU、2048 MiB 内存，内存与 swap 合计同样限制为 2048 MiB、512 MiB `/tmp`、128 MiB shm |
| 时间 | 命令默认 120 秒，可指定至多 1800 秒；容器最多存活一小时；输出最多 64 KiB |
| 网络 | 默认 `none`；显式 `bridge` 允许 Docker 可达网络，包括可能可达的内网，不是公网白名单 |
| 额外文件 | `[[grants]]` 沿用只读/可写权限，经物理文件工具访问；`copy_file` 可导入/导出二进制资料，不自动挂载宿主目录 |
| 生命周期 | 运行结束移除容器，工作文件持久保留；临时目录、进程和浏览器会话不跨运行保存 |
| 取消/超时 | 移除整个容器及子进程，确认后记录 `stopped:true`；停止失败保留标记，不能声称已停止 |
| 重启 | worker 获得唯一锁后清理旧容器，记录真实停止回执，再按 checkpoint 和操作记录继续；不确定副作用等待决定 |

启用 bridge 后可按用户任务访问网页或下载依赖；额外 Python 依赖可安装到 `/workspace` 下的虚拟环境，根目录仍只读。`fetch_public_page` 继续保留其原有公网限制，该限制不扩展到 Shell/浏览器。当前没有宿主服务管理工具、账号连接平台、外部 harness 编排或跨任务保留的登录浏览器。

普通已授权操作不逐命令弹确认。额外目录替换默认 ask，可明确配置 overwrite=allow；bridge 联网默认每任务批准一次，可明确配置 network_authorization=allow 沿用持久授权。财务及自建子智能体保留各自工具范围，不自动获得 Shell。隔离依赖 Docker/宿主安全边界，不等同于恶意多租户隔离认证。

## 附件、产物和恢复

每文件最大 20 MiB，每条消息最多 8 份附件；PNG/JPEG/WebP/GIF 最大 2400 万像素，模型使用最长边 2048 的 JPEG 预览，动画取首帧。SVG/HEIC 等格式作为普通文件处理。原图保留原始数据，预览去除元数据；小字可在执行任务中裁切后再读，不能凭低清图片猜测金额。

数据库升级到 v8，增加资源表及消息/运行附件快照，历史纯文字记录兼容。原件位于 `data_dir/resources`，工作副本位于原有 `uploads`；修改副本不会改变原件。用户附件的 base64 只在模型请求时填充；`view_image` 的工具返回仍可进入 checkpoint。跨模型历史保留引用，并为文字模型移除图片块。

产物检查覆盖 XLSX/DOCX/PPTX/PDF/图片/JSON/UTF-8 文本。XLSX 检查重开和错误单元格，openpyxl 不负责公式重算；结构检查不证明排版正确，回执明确 `visual_checked:false`。技能要求另外渲染并检查页面，模型只有实际检查后才能报告结果。不识别的格式只检查存在、非空和大小。

升级前停止接收任务和 worker，确认容器及文件工具结束，一致性备份整个服务数据目录、checkpoint 和配置。原件、执行所有权标记及资源表必须随数据库保存，不能只迁移工作目录。旧版本无法直接读取 v8 数据库；回滚使用完整升级前快照，并单独保留升级后的写入。已有失败/取消会话的队列继续规则不变。

资源库本次提供预览、分页、已加载名称筛选和下载；收藏、全库搜索、删除原件、资源配额清理未实现。

## 本地验收

2026-09-29，开发机 Docker Engine 29.8.1，Linux aarch64，Python 3.12.14：

- 实际 Deep Agents 图执行 Python 生成 XLSX，重开校验、注册产物、助手消息带附件，结束后无残留容器。
- HTTP 取消 → worker → 正在执行的 Shell：实际子进程停止，后续延时写入未发生；排队消息保留且被阻塞。真实超时、文件传输取消和关闭后禁止重启均通过。
- 容器不继承宿主测试密钥，无 Docker socket，不能写 `/etc`；默认网络不可外连，大于 1 MiB 二进制传输可往返。重启清理覆盖配置关闭但仍有旧标记的情形。
- 实际 Chromium 打开本地测试站，运行 JavaScript、填写/点击、截屏和下载，回读内容一致；公网 bridge 连通性尚未在目标服务网络验收。
- 图和 API 覆盖图片请求、Steer、重试、资源越界拒绝、原件保护和跨模型历史。测试模型回答不冒充云端图片识别质量。
- 实际 LibreOffice 将中文 DOCX 转 PDF，Poppler 渲染页面，检查了标题、正文和表格图像，文件校验通过。这证明工具链可用，不承诺每份模型生成文档自动排版正确。
- 客户端 typecheck、lint、10 项 mobile 测试和 Android/iOS JS bundle 通过；后端全量 pytest 与 ruff 通过，包含显式启用的 Docker 集成测试。最终数量见 PR 验证记录。

当前环境没有百炼/Gemini 模型凭据，本次新增视觉、浏览器决策和执行修复尚未经过真实云模型端到端验收。APK/iOS 原生构建、真机操作、Mac mini 常驻迁移和 myVPS 生产升级也未执行；历史生产验收记录不会被本次本地测试覆盖。
