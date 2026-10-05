# App 图标

2026-10-05：知行采用墨黑底、暖白色折叠路径图形。以抽象的 Z 表达从理解到行动，使用宽笔画和曲线留白，在桌面小尺寸下仍保留轮廓。设计参考 Expo Go 的简洁程度，图形独立生成。

## 接入

- `icon.png`：1024 × 1024 RGB PNG，iOS、旧版 Android 与 Expo 通用图标。保留完整方形画布，圆角由系统处理。
- `android-icon-foreground.png`：1024 × 1024 不透明 PNG，将同一图案缩到 75% 后居中，底色为 `#131211`。前景保留墨黑底，与 adaptive icon 背景搭配；主要图案放在中央直径 66/108 的安全圆内。
- `favicon.png`：64 × 64 RGB PNG，从主图标缩小。
- `icon-red.png` 与 `splash-icon.png` 为旧资源，目前未配置使用。

修改通过 `app.json` 接入；不直接修改 Expo 生成的 `android/`、`ios/`。当前没有设置 Android 主题单色图标，也没有引入新的启动屏配置。桌面图标更新需要重新构建并安装原生 App，JS bundle 验证不代表原生桌面验收。

## 图像来源

使用内置 `image_gen` 生成与修整；`sips` 用于主图和 favicon 的尺寸导出，Node 的 `jimp-compact` 用于 Android 尺寸导出和画布留白。原始方向提示为：单个抽象 Z 形折叠路径，宽笔画、流动曲线、简洁几何、暖白形状与墨黑背景，无文字、阴影或设备模型。

最终生成提示（以初稿图形作为编辑输入）：

> Use case: precise-object-edit. Edit the supplied original Zhixing app logo. Keep the Z ribbon outline and its essential proportions. Change the background to a single perfectly solid near-black #131211 color filling the entire square canvas edge to edge. Make the Z emblem perfectly solid warm white #F2F1EE. Remove all the stray speckles and grain around the Z and in the two cutout areas: those areas must be absolutely clean, uniform #131211. Smooth all the outline curves professionally. One flat minimalist mark centered, occupying 60% of the width. Flat two-color art only. No texture whatsoever, no gradient, no bevel, no shadow, no rounded tile corner, no text, no extra marks. A finished production 1024x1024 app icon, not a mockup.
