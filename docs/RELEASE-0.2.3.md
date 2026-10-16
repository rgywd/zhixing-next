# 知行 Next 0.2.3 发布尝试（未发布）

`v0.2.3` 触发的 [Actions 回归](https://github.com/rgywd/zhixing-next/actions/runs/38860111151) 在 Linux SQLite 的 DELETE 日志模式下遇到并发测试同步问题，签名构建被阻止，未生成正式 APK，也未公开 GitHub Release。

原标签与失败记录保留，不移动已有标签。修正测试同步及后续 SDK 初始化后，正式版本顺延为 **0.2.5 / Android versionCode 7**，见[0.2.5 发布说明](RELEASE-0.2.5.md)。客户端业务代码、生产读取逻辑和 SQLite 安全策略不因这项测试修复改变。
