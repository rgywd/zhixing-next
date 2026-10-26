# App 更新与 GitHub 访问诊断

## 2026-10-26 调研结果

本机匿名访问 `api.github.com/repos/rgywd/zhixing-next/releases/latest` 实际返回 403：响应头 `x-ratelimit-limit=60`、`x-ratelimit-used=60`、`x-ratelimit-remaining=0`，响应正文明确为 API rate limit exceeded。同一网络读取官方 `releases/latest/download/app-update.json`，经 GitHub 官方重定向后返回 200，包含完整的 0.2.6 版本、APK 大小和 SHA-256。

这证明当时本机出口 IP 的匿名 API 配额耗尽，不是此仓库需要私有权限，也不是服务令牌或 APK 签名错误。匿名额度按出口 IP 共享，代理、VPN 和共享网络中的其他客户端都可能消耗同一额度。用户随后反馈手机检查已经恢复；没有取得手机当时的响应头，不能把本机复现说成手机每次失败的完整证明。

现有实现还有诊断问题：当 API 先返回 403，备用清单再超时或断网时，界面只保留第一条错误，容易把所有后续失败显示成“GitHub 限制访问”。0.2.5 仅使用 API；0.2.6 已加入清单和缓存，但仍保留上述错误覆盖问题。

官方依据：[REST API 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[API 版本](https://docs.github.com/en/rest/about-the-rest-api/api-versions)、[API 故障排查](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)。明确应用标识和受支持 API 版本不会提高匿名额度；不在 APK 中放 GitHub 令牌来规避限流。

## 0.2.7 行为

手动检查优先读取官方 Release 清单，失败后才调用 REST API。两个来源有独立超时；失败分别保留原因，不以 403 覆盖清单失败。API 403 只有在剩余额度为零、有效 Retry-After 或明确限流正文等证据存在时记录限流冷却，普通拒绝不冒称配额耗尽。10 分钟核验缓存、断网缓存与取消归属继续保留；缓存没有完整安装元数据时必须重新核验。

Android 主操作在 App 内下载到本机私有缓存，显示真实字节进度并支持取消。以同一精确匹配的官方 APK 条目的大小与 `sha256:` 摘要核对文件。原生模块还检查包名、版本和当前安装签名，使用独立只读副本交给系统安装器；文件通过受限 FileProvider 临时只读授权，不向外部应用开放整个缓存。

首次需允许知行安装应用时，打开此应用对应的系统设置，返回后可继续，无需再次下载。系统仍要求用户确认；返回成功只表示安装器已打开，不声称更新已经完成。同签同版本可显式重新安装，低 versionCode 拒绝。iOS 不安装 APK；发布页保留为用户主动打开的备用入口。

验证包括：双源错误、限流分类、缓存摘要、取消和迟到回调、权限拒绝与重试、重复操作、原生摘要／包名／版本／签名校验、系统安装确认与同签覆盖数据保留。测试、JS 打包、原生预览和正式签名 APK 的验证结果分别记录；实际覆盖范围见本次发布验收回执。
