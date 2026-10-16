# 知行 Next 0.2.4 发布尝试（未发布）

`v0.2.4` 的 [Actions 回归](https://github.com/rgywd/zhixing-next/actions/runs/38861170223) 已通过客户端、后端与真实 Docker 测试，随后签名构建任务因 runner 缺少 `sdkmanager` 停止，未生成正式 APK，也未公开 GitHub Release。

原标签与失败记录保留。工作流改为显式安装匹配的 Android SDK、NDK 与 CMake 后，正式版本顺延为 **0.2.5 / Android versionCode 7**，见[0.2.5 发布说明](RELEASE-0.2.5.md)。客户端业务和后端运行代码保持不变。
