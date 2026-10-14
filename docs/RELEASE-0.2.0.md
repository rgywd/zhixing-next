# 知行 Next 0.2.0：安装与验收

状态：发布准备中。本页记录安装方式与验收要求；尚未回填的项不代表已经通过。本版代码、独立 APK、对应后端和正式 Release 分别验收。

## 这版提供什么

- 入口为首页、财务、知行、健康、设置；工作、项目管理、任务模式与通用计划入口移除，已有历史保留。数据库 v12 首次迁移停用旧主动计划。
- 财务可直接或通过聊天记录收支、退款、转账与累计，修改逐月／沿用预算，查看支出、未付承诺、剩余额度和有依据的结余预测。
- 健康可记录饮食、体重和可选步数，修改身体限制、偏好与带生效期的饮食规范；推荐、采纳／替换困难、实际进食和后续回顾关联保存。规则与记录变化使旧建议过期。
- 同一句明确餐费与实际饮食可以原子写入和纠正；消息及工具重试不重复记账。模型不可用但网络正常时仍可用手工表单。
- 本机用餐／回顾提醒采用约定时区，滚动安排未来 14 天；同步时处理安静时段、每日上限、已记录餐次和暂停日期。“今天不提醒这台手机”可离线取消本机当天排期。长期不打开 App 时不会无限续排，也不会补发已过时段。

提醒是本机排期，不是服务端动态推送。普通退出后的到达、点击跳转、重启和系统限制均须实体手机验证。未记录的餐次保持未知，照片只能提供有依据的份量／能量估计，不是精确营养或医疗判断。

## 手机安装与连接

目标包名 `dev.zhixing.next`，版本 `0.2.0`、Android versionCode `2`。最低 Android API 24（Android 7.0）；本次手机交付面向 `arm64-v8a`，其他 ABI 只有实际构建和验收后才列入附件。正式包内嵌 JS，启动不需要 Metro 或连接开发电脑；AI 及服务记录仍需访问后端。

1. 从对应 GitHub Release 下载 APK 与 SHA-256 清单；**实际链接、文件名和校验值待回填**。
2. 在手机允许该下载来源安装应用，安装后打开“设置 → 服务连接”。
3. 填写可编辑的公网 HTTPS 服务地址和服务访问令牌。地址不能带账号、令牌、查询参数或锚点；正式包不接受 HTTP。构建时可预填 HTTPS 地址，手机仍可修改。
4. 连接后在财务／健康页面开始记录；再按需要配置预算、饮食规范与提醒。没有个人资料或模型时不制造示例记录。

服务令牌放在手机安全存储，供应商密钥只在后端；APK 不内置两类密钥。模型和搜索服务在设置中配置，安装包不绑定某一供应商。

覆盖升级需要保持包名和同一签名证书。签名不同会被 Android 拒绝覆盖；先核对旧包证书、服务连接与未提交草稿，不能为了安装先卸载清空本机数据。后端历史与本机草稿／偏好是两份数据，恢复验证需分别进行。

## 固定签名构建

仓库的 [build_android_release.py](../scripts/build_android_release.py) 读取仓库外的私有 JSON 签名文件，由 [config plugin](../plugins/withAndroidReleaseSigning.cjs) 接入 Expo 生成的 Gradle；不手工维护 `android/`。签名文件在 POSIX 下须为 `0600`，keystore 和密码均不提交仓库。文件字段为：

```json
{
  "keystore": "/private/path/zhixing-release.jks",
  "store_password": "<私有密码>",
  "key_alias": "<固定别名>",
  "key_password": "<私有密码>"
}
```

在已安装 Node、JDK、Android SDK 与 Python 的环境执行：

```sh
python3 scripts/build_android_release.py \
  --signing-file /private/path/android-signing.json \
  --architectures arm64-v8a \
  --server-url https://assistant.example.com \
  --output /private/path/zhixing-next-0.2.0-arm64.apk
```

`--server-url` 应替换为实际已部署的 HTTPS 入口，省略时可由手机填写。脚本只把签名值交给子进程环境，不作为命令行参数；缺少正式签名时 config plugin 拒绝 release 构建。长期保管同一 keystore，丢失后不能保证原包覆盖升级。

构建后用 Android SDK 的 `apksigner verify --verbose --print-certs <APK路径>` 核对签名，并生成 SHA-256。发布后重新下载附件比较哈希，不能把本地文件哈希当成下载验收。

## 后端升级与独立验收

后端 v12 增加财务、健康和同餐关联数据，不把旧余额／收支观察自动解释成确定日期的新流水。升级前停止接收新运行与 worker，按[备份与恢复说明](DEPLOYMENT.md)备份数据库及相关资源，在副本验证迁移、旧计划停用、完整性和恢复，再部署同一提交；只保留一个活动 worker。回滚 v12 应恢复升级前一致性备份，不让旧服务直接写新 schema。

自动检查在最终提交运行：

```sh
npm run typecheck
npm run lint
npm run test:mobile
npm run bundle:android
npm run bundle:ios
```

在 `backend/` 运行 `uv run pytest -q`、`uv run ruff check .`。JS bundle、测试模型和模拟器分别只证明相应链路，不能代替独立安装、真实模型或实体手机验收。

真实模型多轮验收使用 [accept_life_services.py](../scripts/accept_life_services.py)。它默认拒绝非 `127.0.0.1` 端点，要求空的隔离实例、显式隔离开关和私有标记文件，不得指向生产个人数据库。

运行环境需设置 `ZHIXING_ACCEPT_BASE`、`ZHIXING_API_TOKEN`、`ZHIXING_ACCEPT_ISOLATED=fictional-only`、绝对路径 `ZHIXING_ACCEPT_DIR`；该目录内普通文件 `ISOLATED_ACCEPTANCE` 的内容为 `zhixing-next-fictional-acceptance-v1`。令牌通过进程环境注入，不写命令行、仓库或日志。在 `backend/` 执行：

```sh
uv run python ../scripts/accept_life_services.py --stage all
```

也可依次执行 `--stage setup`、`dual_record`、`recommendation`、`replacement`、`adoption`、`correction`、`rule_change`、`review`。脚本轮询真实运行并核对服务记录与工具回执，重跑沿用保存的消息 ID，不自动换新来源重发失败运行；stdout 仅输出状态、ID 和计数，模型文本在私有目录供人工检视。自动通过仍需人工确认建议可执行、禁忌与份量合理、引用实际困难、不编造商家价格或将漏记判为没吃。

## 发布验收记录

| 验收项 | 结果／证据 |
| --- | --- |
| 最终提交、CI 结论 | 待回填提交 SHA、工作流链接与结论 |
| TypeScript、lint、移动回归、Android／iOS bundle | 待回填最终提交结果 |
| 后端回归、Ruff、v12 副本迁移及恢复 | 待回填命令结果与备份／恢复证据 |
| 真实模型：餐费＋饮食 → 推荐 → 替换 → 采纳 → 实际记录 → 纠正 → 改规范 → 回顾 | 待回填隔离脚本结果与人工核对 |
| 对应后端部署、公网 HTTPS、重启持久化 | 待回填主机、提交、schema 与接口回执；不记录凭据 |
| APK 原生构建、ABI、最低 SDK、证书与本地 SHA-256 | 待回填 APK 路径及检查结果 |
| 实体手机脱离电脑安装／启动、直接记录、聊天、纠正、断网草稿与恢复 | 待回填机型、系统、操作及结果 |
| 实体手机普通退出后提醒、点击健康、改时段、取消、离线当天暂停、重启 | 待回填实收与取消证据；排期 API 成功不等于实收 |
| 旧包覆盖升级，历史／连接／草稿保留 | 待回填旧新版本与签名、数据核对 |
| 正式标签与 GitHub Release、APK／校验清单 | 待回填标签提交、Release 和附件链接 |
| 下载 Release 附件并核对哈希、安装抽查 | 待回填下载哈希与安装结果 |

只有相应实测完成后才把结果改为通过。原生 iOS 构建与 iPhone 安装不属于本次 Android 安装包交付，iOS JS bundle 不能证明它们。
