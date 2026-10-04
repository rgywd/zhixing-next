# 安卓手机能力

设置 → 通用 → 手机能力。未连接服务器也可使用；进入页面只读取状态，不自动请求权限。
首批能力由 `src/deviceCapabilities.ts` 接入，权限与单次定位收尾逻辑在 `src/deviceCapabilityLogic.ts`。
操作回执和拒绝权限提示复用共享 `useNotice` 悬浮提示栏，系统设置入口可直接放在提示栏中；不占页面布局空间。

| 能力 | 当前行为 | 授权与边界 |
| --- | --- | --- |
| 通知栏 | 允许通知、发送真实本机测试通知、查看系统权限与知行渠道状态 | 点击时先创建“知行通知”渠道，再申请 Android 13+ 通知权限；渠道单独关闭也会提示打开设置 |
| 系统日历 | 新建系统日程；定时计划可把本次执行时间带入系统编辑器 | 用户在日历中选择提醒并保存；不读取全部日程，不申请 READ/WRITE_CALENDAR |
| GPS / 定位 | 获取一次新鲜位置，显示坐标、获取时间、实际精度及模拟位置标记 | 只申请使用时定位；允许大概位置；取消、20 秒超时、进入后台或离开页面均停止监听 |

位置不自动写入服务器或本机存储。已连接用户可点“带入对话”，追加到欢迎页已有草稿，仍需自己发送。
不调用反向地理编码，不根据经纬度编造地址；精度未知时明确显示未知。

系统设置返回后重新读取通知权限、渠道与定位服务状态，拒绝授权不影响其他页面。
定位 watcher 注册晚于取消或首次结果时，也会在注册完成后立即释放。

日历使用 SDK 57 的显式 `expo-calendar/legacy` 编辑器 API。默认入口的同名旧 API 会在运行时抛错。
导出保留计划的时间点，不假设活动时长；重复计划只导出本次时间，重复规则由用户在系统日历中设置。
Android 编辑器返回结果不能证明保存，因此页面不会显示“已添加”或自动标记已同步。
修改日历不会改变服务器计划；再次打开编辑器可能创建另一条日程。
没有可处理日程的日历应用时显示错误并恢复操作入口。

当前没有服务器通知 token 注册、FCM / Expo Push 投递或后台任务监听。
本机通知验收不代表 App 关闭或被系统结束后能够收到任务结果。
没有添加后台定位、定位前台服务或精确闹钟权限。

## 原生运行

依赖通过 `npx expo install expo-notifications expo-calendar expo-location` 选择 SDK 57 兼容版本，锁在 npm lockfile。
原生配置统一在 `app.json`；`android/`、`ios/` 仍是忽略的 Expo 生成目录。
日历需要包含新原生模块的开发包；Expo Go 不能替代该验收。

```sh
npm ci
npm run android
```

官方依据：[Notifications SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)、
[Calendar SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/calendar/)、
[Calendar legacy SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/calendar-legacy/)、
[Location SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/location/)。

实际原生构建与交互结果见 [2026-09-30 验收记录](ANDROID-CAPABILITIES-ACCEPTANCE-2026-09-30.md)；JS bundle 不代表 iOS 原生验收。
