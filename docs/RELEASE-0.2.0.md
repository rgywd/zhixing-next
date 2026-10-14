# 知行 Next 0.2.0：安装与验收

状态：2026-10-14 已正式发布。[v0.2.0 Release](https://github.com/rgywd/zhixing-next/releases/tag/v0.2.0) 对应提交 [`adeeb65e123989ac3edce4d20cf56165118f3dca`](https://github.com/rgywd/zhixing-next/commit/adeeb65e123989ac3edce4d20cf56165118f3dca)，[功能 PR #17](https://github.com/rgywd/zhixing-next/pull/17) 已合并，[四项 CI](https://github.com/rgywd/zhixing-next/actions/runs/38549759078) 全部成功。独立 APK、对应生产后端与下载附件均已核查。

本次按用户要求先用 Android 模拟器完成原生验收。实体 Android 手机未覆盖，不作为此次发布门槛；原生 iOS 构建与 iPhone 安装也未覆盖。

## 这版提供什么

- 入口为首页、财务、知行、健康、设置；工作、项目管理、任务模式与通用计划入口移除，已有历史保留。数据库 v12 首次迁移停用旧主动计划。
- 财务可直接或通过聊天记录收支、退款、转账与累计，修改逐月／沿用预算，查看支出、未付承诺、剩余额度和有依据的结余预测。
- 健康可记录饮食、体重和可选步数，修改身体限制、偏好与带生效期的饮食规范；推荐、采纳／替换困难、实际进食和后续回顾关联保存。规则与记录变化使旧建议过期。
- 同一句明确餐费与实际饮食可以原子写入和纠正；消息及工具重试不重复记账。模型不可用但网络正常时仍可用手工表单。
- 本机用餐／回顾提醒采用约定时区，滚动安排未来 14 天；同步时处理安静时段、每日上限、已记录餐次和暂停日期。“今天不提醒这台手机”可离线取消本机当天排期。长期不打开 App 时不会无限续排，也不会补发已过时段。

提醒是本机排期，不是服务端动态推送。本次已在模拟器观察到 HOME 退出后实际通知、点击健康页和重启后首次打开的排期恢复；通知约晚于约定时点一分钟，不能保证准时送达，具体边界见下方记录。未记录的餐次保持未知，照片只能提供有依据的份量／能量估计，不是精确营养或医疗判断。

## 手机安装与连接

目标包名 `dev.zhixing.next`，版本 `0.2.0`、Android versionCode `2`。最低 Android API 24（Android 7.0）；本次手机交付面向 `arm64-v8a`，其他 ABI 只有实际构建和验收后才列入附件。正式包内嵌 JS，启动不需要 Metro 或连接开发电脑；AI 及服务记录仍需访问后端。

1. 下载 [ARM64 APK](https://github.com/rgywd/zhixing-next/releases/download/v0.2.0/zhixing-next-0.2.0-arm64.apk) 与 [SHA-256 清单](https://github.com/rgywd/zhixing-next/releases/download/v0.2.0/SHA256SUMS.txt)。也可使用已实测下载并安装的 [HTTPS 镜像 APK](https://work.8-208-118-119.sslip.io/assistant-downloads/zhixing-next-0.2.0-arm64.apk)，文件与 GitHub 附件哈希一致。
2. 在手机允许该下载来源安装应用，安装后打开“设置 → 服务连接”。
3. 填写可编辑的公网 HTTPS 服务地址和服务访问令牌。地址不能带账号、令牌、查询参数或锚点；正式包不接受 HTTP。构建时可预填 HTTPS 地址，手机仍可修改。
4. 连接后在财务／健康页面开始记录；再按需要配置预算、饮食规范与提醒。没有个人资料或模型时不制造示例记录。

服务令牌放在手机安全存储，供应商密钥只在后端；APK 不内置两类密钥。模型和搜索服务在设置中配置，安装包不绑定某一供应商。

APK SHA-256：

```text
e3f984a8c761218e9bb7310f5ea881b53f92e32b9f83fd1cff530d9fce6edc15
```

覆盖安装需要保持包名和同一签名证书。本次是首个正式签名版本，已在两个同证书候选 APK 之间验证覆盖安装，连接和未发送草稿保留；这不代表可覆盖早期 debug 签名包。签名不同会被 Android 拒绝覆盖；先核对旧包证书、服务连接与未提交草稿，不能为了安装先卸载清空本机数据。后端历史与本机草稿／偏好是两份数据，恢复验证需分别进行。

本次正式证书 SHA-256 为 `3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4`。安装包包含的原生库仅为 `arm64-v8a`，manifest 最低 SDK 为 24、target SDK 为 36；没有把 x86 或其他 ABI 包列为本次手机附件。

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

构建脚本还生成公开构建回执，包含 commit、工作树是否有未提交改动、版本、APK 实际 ABI、SDK、默认公开地址和哈希，不含签名路径或凭据。本次从干净的 `adeeb65` 构建。用 Android SDK 的 `apksigner verify --verbose --print-certs <APK路径>` 核对签名；本次已对 GitHub 回读 APK 再次核查证书和签名。缺签名的 `assemble`、`aR`、`build` 任务图均已确认拒绝，不会回退到 debug 签名。

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

机器可读的[公开验收回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.0/acceptance.json)、[验收说明](https://github.com/rgywd/zhixing-next/releases/download/v0.2.0/ACCEPTANCE.md)和[构建回执](https://github.com/rgywd/zhixing-next/releases/download/v0.2.0/build.json)已随 Release 上传。回执只公开布尔结果、统计、构建来源与制品信息，不包含服务令牌、个人资料、真实界面截图或私有备份校验值。

| 验收项 | 实际结果 |
| --- | --- |
| 正式提交与 CI | 标签 `v0.2.0` 指向 `adeeb65`；PR #17 已合并。功能 PR 的后端、移动端、Docker、分支策略四项 CI 成功，链接见页首。 |
| 客户端自动检查 | TypeScript、lint、148 项移动回归与 Android／iOS JS bundle 通过。 |
| 后端自动检查 | 334 项回归与 Ruff 通过；本地未启用的 16 项 Docker 专项由成功的 Docker CI 覆盖。 |
| 真实模型 | 隔离虚构数据完成配置、联合记餐记账、建议、替换困难、采纳与实际进食、纠正、改规范、回顾八阶段。人工审阅后补充用餐条件、未知份量与配料风险提示，最终 12 项补充检查通过；运行模块与发布代码一致。 |
| 原生模拟器 | Android 16 / API 36 / ARM64 共 23 项检查完成，覆盖独立安装、320dp、手工记录和原 ID 纠正、单日饮食规范、键盘与返回、冷启动草稿、断网原请求恢复且仅提交一次、建议与历史、权限、提醒及下载覆盖安装等。 |
| 本机提醒实收 | HOME 退出后系统通知实际出现，约比约定时点晚一分钟；点击进入健康页。离线暂停当天后，当天余下提醒取消、未来 26 条保留；联网同步未重建当天提醒。 |
| 重启提醒观测 | AVD 完成重启，首次打开 App 后恢复未来 26 条排期。当日两个时段在重启时已过，不能仅凭当天提醒为 0 独立证明暂停状态跨重启持久；离线暂停与联网重同步取消是在重启前直接核查。未把这次观测写成无需打开 App 的系统自动恢复证明。 |
| 生产部署 | 同一提交已上线，数据库 v12。停服后的完整备份经 SHA-256 校验和完整解压恢复；副本迁移、生产完整性与外键检查通过，旧表无丢行，旧通用计划停用。 |
| 生产接口与重启 | 本地 HTTP 与公网 HTTPS 健康 200、无令牌状态 401、带令牌状态 200；真实模型连通检查完成。重启后配置与原有资料保留，`model_ready`、`worker_online` 均为 true，无活动运行。 |
| 同证书覆盖安装 | 两个同证书候选包覆盖安装后，服务连接与未发送草稿保留；未宣称覆盖旧 debug 签名安装。 |
| 发布与下载 | 正式 Release 的 APK、构建回执、验收 JSON、验收说明和 SHA-256 清单五项附件均上传完成。GitHub 回读的四个制品逐项符合清单，APK 签名复验通过；镜像回读哈希同上，且已将镜像下载文件实际覆盖安装。 |
| 收尾 | 模拟器最终 App 连接生产并只读核查，未向生产写入验收流水。临时测试 App、令牌输入文件、隔离公网路由与服务已清理，旧连接提醒撤销；真实生产界面截图保留私有。 |

本次交付仅覆盖 ARM64 Android APK。实体 Android 手机及不同厂商电池策略未测试，iOS 仅通过 JS bundle；提醒不承诺准点，本机滚动排期也不等于服务端动态推送。用户后续在实体手机安装时，可按本页相同流程核对实际通知、重启与系统限制，无需把这些未覆盖项写成本次已通过结果。
