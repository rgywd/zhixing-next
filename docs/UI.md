# 共享 UI

客户端以生活页的比例为基准，保留暖白底与红色强调。颜色、字阶、间距、圆角和页面尺度由
[`src/theme.ts`](../src/theme.ts) 维护；可复用组件与样式由 [`src/ui.tsx`](../src/ui.tsx) 维护。
调整同一种视觉元素时修改共享定义，不在各页面复制数值。

## 页面组合

- 首页、生活、工作、工具箱使用 `PageScrollView tabs` 与 `PageHero`。`tabs` 负责浮动底栏留白，
  页头插画通过 `art` 和 `artStyle` 接入；插画位置等专有排版留在所属页面。
- 管理子页使用普通 `PageScrollView`、`PageHeading`，由外层提供 `BackLink`。子页不预留底栏空白。
- 模态页使用 `SheetHeader` 和普通 `PageScrollView`；关闭回调仍由原页面持有。
- 卡片使用 `s.card` 和 `CardHeader`；双列入口使用 `ServiceTile`，纵向入口使用 `ActionRow`。
  `ActionRow compact` 用于最近对话等较密的列表，末行传 `last` 去掉分隔线。窄屏时 `ServiceTile`
  自动变为单列，带插画的 `PageHero` 自动收窄文字区域。
- 按钮、输入和空状态使用 `Button`、`Field`、`Empty`。`Empty compact` 用于卡片内部；
  正文阅读使用 `s.text`，说明使用 `s.description`，辅助信息使用 `s.muted`。

```tsx
<PageScrollView tabs>
  <PageHero eyebrow="WORK" title="工作" description="对话、项目与计划。" />
  <View style={s.card}>
    <CardHeader icon="folder-outline" title="项目" />
    <Button icon="add" onPress={onCreateProject}>创建项目</Button>
  </View>
</PageScrollView>
```

共享组件负责外观、触摸区域和无障碍语义，不请求数据或决定业务跳转。页面传入文字与回调，
保留原有加载、错误和禁用条件。沉浸式聊天可以保留消息气泡和输入区的专有布局，通用文字与控件仍复用全局基础。

新增页面先选以上组合；只有插画、专有网格、消息等内容布局需要局部 `StyleSheet`。
通用的字号、卡片间距和图标底座不再另建一套。视觉修改除客户端门禁外，需检查主页面、代表性子页、
320dp 窄屏及返回路径，原生运行验收与 JS bundle 结果分别记录。
