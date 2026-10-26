# 知行 Next 0.2.7：人格成长与 App 内更新

版本 `0.2.7`，Android versionCode `9`，包名 `dev.zhixing.next`，正式 ARM64 APK。沿用既有签名，直接覆盖安装，保留服务连接、偏好、草稿与本机加密密码库；不要先卸载。

## 本次更新

- Android 更新在知行内下载，显示真实进度并支持取消。下载完成后核对大小、SHA-256、包名、版本和当前安装签名，再打开 Android 系统安装确认。首次安装更新可能需要允许知行安装应用；返回后可继续，无需再次下载。成功打开安装器不表示安装已经完成。
- 检查更新优先读取官方 Release 更新清单，REST API 作为备用，减少匿名出口 IP 配额耗尽造成的拒绝。两个来源均失败时分别说明原因，保留已核验缓存和明确核验时间，不把旧缓存称为实时最新。不向 GitHub 发送服务令牌或个人资料。
- 纳入 Muse 人格基底、全库记忆搜索、核心偏好与明确人物称谓召回。演化人格、方法经验、主动消息偏好和个人目标持久保存，纠正与遗忘使旧派生理解失效。
- 新版在原聊天中区分主动跟进与普通回复，不生成虚构处理过程。静默维护默认开启，主动消息需在聊天里启用，并遵守话题、安静时段、暂停与频率限制。

旧版的更新入口仍会打开浏览器，须先通过它或下方链接安装本版；之后的 APK 下载与安装入口在 App 内完成。iOS 不安装 Android APK；远程手机推送、外部事件监控与自动安装可执行技能未接入。

## 安装与附件

要求 ARM64、Android 7.0／API 24 起；本机密码库要求 API 26 起。JS 内嵌，无需 Metro。APK 不包含服务访问令牌或模型密钥。

正式发布由标签 `v0.2.7` 触发 [Android release](https://github.com/rgywd/zhixing-next/actions/workflows/release.yml)，完成回归、签名构建、附件校验后公开。普通提交与 PR 不运行 Actions。

- [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.7/zhixing-next-0.2.7-arm64.apk)
- [构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.7/zhixing-next-0.2.7-arm64.apk.build.json)
- [SHA256SUMS](https://github.com/rgywd/zhixing-next/releases/download/v0.2.7/SHA256SUMS)
- [官方更新清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.7/app-update.json)

固定正式证书 SHA-256：`3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。正式构建、下载校验、覆盖安装和 App 内安装链路以本次发布回执为准；本地测试和 JS 打包不代替原生运行。

## 服务与验证边界

人格成长与主动服务使用后端 schema v15，合并提交 `04a2ece` 已于 2026-10-24 完成独立生产部署与备份恢复验收。发布此 APK 不会再次迁移生产数据库。升级后的 v15 数据不能只切回旧 v14 程序；完整回滚须同时恢复升级前完整数据和配套旧程序。

心跳的有限真实模型样例通过核心场景，仍有免打扰建议、跨午夜“明早”等措辞质量观察，详见[成长验收](ACCEPTANCE-MUSE-GROWTH-2026-10-23.md)。本轮 Android 原生验收使用独立模拟器；实体手机和原生 iOS 结果另行说明，不沿用旧版验收当作本版证明。
