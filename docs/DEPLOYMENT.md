# myVPS 部署与恢复

2026-09-23：本页维护 Linux/systemd 部署步骤；是否已上线及实际提交、模型调用结果由部署验收回执记录。
新助手独立安装，复用现有 HTTPS Nginx 入口的 `/assistant` 路径。旧知行服务与它的数据目录保持独立。

## 布局

| 内容 | 路径或约定 |
| --- | --- |
| 每次已验收代码包 | `/opt/zhixing-next/releases/<完整 commit SHA>/` |
| 当前后端软链接 | `/opt/zhixing-next/backend` → 某个 release 的 `backend` |
| 独立 uv / 托管 Python | `/opt/zhixing-next/bootstrap/uv` / `/opt/zhixing-next/.python` |
| 公开模型配置 | `/etc/zhixing-next/config.toml`，`root:zhixing-next`，`0640` |
| 进程密钥 | `/etc/zhixing-next/service.env`，`root:root`，`0600` |
| 数据、checkpoint、工作文件 | `/var/lib/zhixing-next`，`zhixing-next:zhixing-next`，`0700` |
| 服务 | `zhixing-next-api.service` 与 `zhixing-next-worker.service` |
| API | `127.0.0.1:8791`；外部只走现有 HTTPS 入口 |
| App 服务地址 | `https://现有域名/assistant`，不追加 `/v1` |

只运行一个 worker；数据库在主机本地磁盘。API 与 worker 共用配置、密钥和数据目录。
本页命令使用服务器上的 root Bash，代码包应已传到相应 release 目录；不依赖远端 Git、root home 中的 Python 或 uv。
先记录旧服务健康地址和返回值，确认 `8791` 空闲，并保存本次完整提交、源代码包校验值和已有 Nginx 配置位置。

## 首次安装

```bash
read -r -p '已验收的完整 commit SHA: ' REVISION
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || exit 1
RELEASE="/opt/zhixing-next/releases/$REVISION"
test -f "$RELEASE/backend/uv.lock" || exit 1
getent passwd zhixing-next >/dev/null || useradd --system --user-group \
  --home-dir /var/lib/zhixing-next --shell /usr/sbin/nologin zhixing-next
install -d -o root -g zhixing-next -m 0750 /etc/zhixing-next
install -d -o zhixing-next -g zhixing-next -m 0700 /var/lib/zhixing-next
umask 022
cd "$RELEASE/backend"
UV_PYTHON_INSTALL_DIR=/opt/zhixing-next/.python \
  /opt/zhixing-next/bootstrap/uv sync --locked --no-dev --python 3.12
runuser -u zhixing-next -- "$RELEASE/backend/.venv/bin/python" \
  -c 'import zhixing_next, uvicorn; print("runtime import ok")'
```

独立 uv 需事先从可信发行渠道安装并核对版本。也可使用已有系统 Python 3.12；关键是服务用户能访问
`.venv/bin/python` 最终指向的解释器。服务启用 `ProtectHome=true`，不能使用安装在 `/root` 下的解释器。
将代码和运行库保留为 root 所有，服务用户只需读和执行权限。

复制 [百炼新加坡示例](../backend/config.bailian.example.toml) 作为实际配置，并在 TOML 首个表之前增加数据路径：

```bash
test ! -e /etc/zhixing-next/config.toml || exit 1
{
  printf 'data_dir = "/var/lib/zhixing-next"\n'
  printf 'workspace_root = "/var/lib/zhixing-next/workspaces"\n\n'
  cat "$RELEASE/backend/config.bailian.example.toml"
} > /etc/zhixing-next/config.toml
chown root:zhixing-next /etc/zhixing-next/config.toml
chmod 0640 /etc/zhixing-next/config.toml
```

模型 ID、区域和账号权限需要用实际调用确认。示例里的 `reasoning_effort` 是供应商模型参数；
`model_ready=true` 只证明配置齐全且密钥环境变量非空，不能替代真实推理验收。

通过受控 SSH 通道将仅含 `api_key`、`api_token` 两项的 JSON 送入
[install_secrets.py](../deploy/install_secrets.py) 的标准输入。服务令牌至少 24 字符，使用随机值。
该脚本需 root 执行，原子写入 `service.env`、限制为 `0600`，只输出安装回执。
命令形态为 `python3 "$RELEASE/deploy/install_secrets.py"`，输入来自安全的进程管道；
不把 JSON 保存到代码包、临时明文文件、命令参数或日志。systemd 以 root 读取 EnvironmentFile 后传给服务进程。

安装服务并启动：

```bash
test ! -e /opt/zhixing-next/backend || test -L /opt/zhixing-next/backend || exit 1
ln -sfn "$RELEASE/backend" /opt/zhixing-next/backend
install -m 0644 "$RELEASE/deploy/systemd/zhixing-next-api.service" /etc/systemd/system/
install -m 0644 "$RELEASE/deploy/systemd/zhixing-next-worker.service" /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/zhixing-next-api.service \
  /etc/systemd/system/zhixing-next-worker.service
systemctl daemon-reload
systemctl enable --now zhixing-next-api.service zhixing-next-worker.service
curl --fail --silent --show-error http://127.0.0.1:8791/healthz
systemctl is-active zhixing-next-api.service zhixing-next-worker.service
```

两个服务独立重启，API 不因 worker 暂时离线而停止。服务使用 `UMask=0077`，写入仅开放给数据目录。
若通过 `[[grants]]` 允许其他文件目录，仍需满足服务用户的 Unix 权限；可写目录还需要在两个 unit 的
drop-in 中明确加入 `ReadWritePaths=`。默认禁止访问 home。应用授权和系统权限必须同时允许，
不能把配置、数据库或密钥目录作为资料授权。这些限制不等于已接入 Shell 沙盒；当前仍无 Shell 工具。

## 接入现有 Nginx

在修改前备份实际 HTTPS server 配置，以下变量应在同一终端保留到验收完成：

```bash
read -r -p '现有 HTTPS server 配置绝对路径: ' NGINX_SITE
[[ "$NGINX_SITE" = /etc/nginx/* ]] && test -f "$NGINX_SITE" || exit 1
read -r -p '旧服务的完整健康检查 URL: ' OLD_HEALTH_URL
curl --fail --silent --show-error "$OLD_HEALTH_URL"
BACKUP="/var/backups/zhixing-next/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 "$BACKUP"
cp -a -- "$NGINX_SITE" "$BACKUP/nginx-site.conf"
install -d -m 0755 /etc/nginx/snippets
install -m 0644 "$RELEASE/deploy/nginx/assistant.conf" \
  /etc/nginx/snippets/zhixing-next-assistant.conf
```

检查现有 server 没有冲突的 `/assistant` 路由，在它的 **HTTPS server 块内部**增加一行：

```nginx
include /etc/nginx/snippets/zhixing-next-assistant.conf;
```

模板仅添加新路径，不替换旧 server、证书、其他 location 或全局 Nginx 配置。
`proxy_pass` 尾部 `/` 用于去掉 `/assistant/` 前缀；认证头继续转发，Nginx 接收上限为 25 MiB，后端单文件上限仍为 20 MiB，
此路径关闭访问日志、缓存和代理缓冲。不要对外开放 `8791`。

```bash
nginx -t && systemctl reload nginx
read -r -p '新的完整 HTTPS 基地址（以 /assistant 结尾）: ' PUBLIC_BASE
curl --fail --silent --show-error "$PUBLIC_BASE/healthz"
curl --silent --show-error -o /dev/null -w '%{http_code}\n' "$PUBLIC_BASE/v1/status"
curl --fail --silent --show-error "$OLD_HEALTH_URL"
```

三个检查分别应为新服务 `200`、无令牌产品接口 `401`、旧服务保持原成功状态。
配置测试失败则不要 reload；新路由或旧服务回归失败时恢复已备份的 server 配置，再 `nginx -t` 后 reload。

## 认证与端到端验收

以下命令供用户本人在自己的终端**有意识地显示 App 服务令牌**，仅复制到 App 的连接设置：

```bash
ssh -t myVPS "sudo sed -n 's/^ZHIXING_API_TOKEN=//p' /etc/zhixing-next/service.env"
```

它只显示 `ZHIXING_API_TOKEN`，不显示百炼 key；不要将这一步纳入自动验收日志或把输出回传聊天。
App 填入 HTTPS 基地址和令牌后，确认 `model_ready=true`、`worker_online=true`、`file_tools_available=true`。
`execution_available=false` 目前是正确状态，表示 Shell 尚未接入。

至少完成一次真实聊天，以及一次“上传文本 → 要求读取并写出结果 → 下载结果”的任务；检查产物内容与运行回执。
再确认 Queue/Steer 的归属和一次性计划能实际执行。验证时保留脱敏的运行 ID、状态、耗时与产物校验值，
不要记录消息全文、模型 key、服务令牌或含签名的 URL。仅 `/healthz` 成功不代表模型与任务链路可用。

## 日常观察与重启

```bash
systemctl show zhixing-next-api.service zhixing-next-worker.service \
  -p ActiveState -p SubState -p NRestarts -p MemoryCurrent -p MemoryPeak
journalctl -u zhixing-next-api.service -u zhixing-next-worker.service --since '30 minutes ago' --no-pager
free -h
df -h /var/lib/zhixing-next
du -sh /var/lib/zhixing-next
```

API 访问日志已关闭，worker 将 HTTP 客户端日志限制在 WARNING 及以上。排障不要开启 HTTP DEBUG 或打印环境变量。
应用事件/工具回执仍存数据库；导出日志前检查脱敏。小内存 VPS 保持一个 API 进程、一个 worker，
聊天与任务各一个槽位；先观察 RSS、可用内存、服务重启次数和磁盘增长，不增加多进程或额外数据库。
若服务反复重启或内核报告 OOM，先暂停新任务并定位资源消耗；不通过不断自动重放失败任务掩盖问题。

配置或密钥改变后，API 和 worker 都要重启：

```bash
systemctl restart zhixing-next-api.service zhixing-next-worker.service
```

停止前尽量让正在运行的任务完成。重启会保留 queued 输入，将遗留 running 标成 interrupted 并暂停该会话；
检查工具回执后由用户继续队列或发送新要求。failed/interrupted 不自动重放，“继续队列”只推进未开始的输入。
强制停止时外部调用和文件操作的结果可能尚未确认，不能把进程恢复误当任务成功。

## 备份、升级和回滚

升级前保留上一份 release 和当前软链接目标，并在停止所有写入后备份整个数据目录：

```bash
BACKUP="/var/backups/zhixing-next/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 "$BACKUP"
readlink -f /opt/zhixing-next/backend > "$BACKUP/previous-backend.txt"
systemctl stop zhixing-next-api.service
systemctl stop zhixing-next-worker.service
for unit in zhixing-next-api.service zhixing-next-worker.service; do
  test "$(systemctl show "$unit" -p ActiveState --value)" = inactive || exit 1
done
umask 077
tar --acls --xattrs -C /var/lib -cpf "$BACKUP/state.tar" zhixing-next
cp -a /etc/zhixing-next/config.toml "$BACKUP/config.toml"
sha256sum "$BACKUP/state.tar" > "$BACKUP/state.tar.sha256"
```

备份包含全部 SQLite 日志、checkpoint、工作文件与权限；不能只复制活动的 `.sqlite`。
`service.env` 留在受限原位置，不放进代码包或常规日志。备份包含个人资料，保持 root 专用权限。
初次上线前没有旧数据时，只需保留原 Nginx 配置作为撤销入口。

新版本解压到新的 `releases/<sha>`，按首次安装步骤为该版本创建独立 `.venv`，配置与数据沿用原目录。
在服务已停止的前提下将 `/opt/zhixing-next/backend` 链接切到新版本，按需更新 unit 并 daemon-reload，
启动服务后重新检查本地/公网健康、认证状态、真实模型与文件链路、旧服务健康。不要在运行中的 release 目录覆盖代码。

仅代码回滚时使用备份记录的旧目标：

```bash
PREVIOUS_BACKEND=$(cat "$BACKUP/previous-backend.txt")
[[ "$PREVIOUS_BACKEND" = /opt/zhixing-next/releases/*/backend ]] || exit 1
test -x "$PREVIOUS_BACKEND/.venv/bin/python" || exit 1
systemctl stop zhixing-next-api.service
systemctl stop zhixing-next-worker.service
ln -sfn "$PREVIOUS_BACKEND" /opt/zhixing-next/backend
systemctl start zhixing-next-api.service zhixing-next-worker.service
```

若本次改过 unit/config，还要恢复与旧版本匹配的文件后 daemon-reload。回滚后执行相同健康与旧服务回归。
代码回滚优先保留现有数据；仅确认数据库版本不兼容、且接受丢弃备份后写入时才恢复匹配的数据备份。
恢复前先停两服务，将当前完整数据目录改名留存，验证归档校验值后恢复 `state.tar` 到 `/var/lib`，
检查所有权与 `0700` 目录权限，再启动。迁往 Mac 时同样整体迁移并验证，始终只有一个活动 worker。

相关实现依据：[systemd 执行环境](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)、
[Nginx proxy_pass 路径行为](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)、
[uv 托管 Python 位置](https://docs.astral.sh/uv/concepts/python-versions/#managed-python-directory)。
