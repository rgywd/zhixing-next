# 共享 UI

客户端使用日夜两套主题，颜色、字阶、间距与尺度由 [`src/theme.ts`](../src/theme.ts) 维护。
白天以白色底面、朱红主操作、金色选中与思考状态为主；搜索、资料等功能少量使用冷蓝。
夜间参考 Grok 的近黑底面与炭灰浮层，主操作使用柔白，暗金用于选中与思考，卡其用于辅助图标。
绿色只保留成功等状态含义，模型品牌图标保留原色。夜间隐藏为浅色背景绘制的装饰插画。

[`ThemeProvider`](../src/ThemeProvider.tsx) 统一管理“跟随系统 / 白天 / 夜间”，默认跟随系统，偏好保存在本机。
页头外观图标与设置首页都可打开同一个底部选择器，未连接服务也可调整；切换不重挂载页面，不清空草稿。
Expo 使用 `userInterfaceStyle: automatic` 与 `expo-system-ui`，状态栏、系统根背景和原生外观随主题变化。
新增原生依赖需要重建 development build；Expo Go 的运行验收不能替代独立原生包验收。

页面在组件内通过 `useUi()` 获取 `s` 和 `colors`，专有样式使用 `useThemedStyles(createStyles)`；
样式工厂接收 `ThemeColors`，禁止在模块顶层固定当前配色。底面使用 `surface` / `surfaceRaised`，
填充按钮分别使用 `primary` / `onPrimary`、`ink` / `onInk`，不能把白色同时当作背景与按钮文字。
共享组件由 [`src/ui.tsx`](../src/ui.tsx) 维护，同一种元素修改共享定义，不在各页面复制数值。

## 页面组合

- 首页、生活、工作、设置使用 `PageScrollView tabs` 与 `PageHero`。`tabs` 负责浮动底栏留白，
  页头插画通过 `art` 和 `artStyle` 接入；插画位置等专有排版留在所属页面。
- 管理子页使用普通 `PageScrollView`、`PageHeading`，由外层提供 `BackLink`。子页不预留底栏空白。
- 模型、思考、搜索等即时选择与创建项目等短表单使用 `BottomSheet`，保留当前页面背景。支持淡入遮罩、滑入／滑出、下拉手柄、点击遮罩和系统返回；尊重系统减少动态效果设置。文件浏览、任务记录、完整对话列表等长内容页仍使用 `SheetHeader`。
- 卡片使用 `s.card` 和 `CardHeader`；双列入口使用 `ServiceTile`，纵向入口使用 `ActionRow`。
  `ActionRow compact` 用于最近对话等较密的列表，末行传 `last` 去掉分隔线。窄屏时 `ServiceTile`
  自动变为单列，`PageHero` 隐藏装饰插画，为大字号文字保留整行宽度。
- 主要提交动作使用 `Button`，次要动作使用 `ActionLink`，单图标操作使用 `IconAction`。状态使用 `StatusPill`，入口图标可通过 `UiTone` 对应语义色。输入和空状态使用 `Field`、`Empty`。`Empty compact` 用于卡片内部；
  正文阅读使用 `s.text`，说明使用 `s.description`，辅助信息使用 `s.muted`。

```tsx
const { s } = useUi();

<PageScrollView tabs>
  <PageHero eyebrow="WORK" title="工作" description="对话、项目与计划。" />
  <View style={s.card}>
    <CardHeader icon="folder-outline" title="项目" tone="blue"
      action={<IconAction icon="add" label="创建项目" tone="blue" onPress={onCreateProject} />} />
    <ActionLink icon="add" tone="blue" onPress={onCreateProject}>创建项目</ActionLink>
  </View>
</PageScrollView>
```

共享组件负责外观、触摸区域和无障碍语义，不请求数据或决定业务跳转。语义色只说明入口类型或状态，不表示未经验证的模型能力。页面传入文字与回调，
保留原有加载、错误和禁用条件。沉浸式聊天可以保留消息气泡和输入区的专有布局，通用文字与控件仍复用全局基础。

新增页面先选以上组合；只有插画、专有网格、消息等内容布局需要局部 `StyleSheet`。
通用的字号、卡片间距和图标底座不再另建一套。视觉修改除客户端门禁外，需检查主页面、代表性子页、
320dp 窄屏及返回路径，原生运行验收与 JS bundle 结果分别记录。

## 对话与选择器

- 主聊天、首次对话和财务聊天复用 `ConversationComposer`。输入文字在上，模型品牌、搜索状态、思考档位、聊天／任务模式、附件与发送在同一条工具栏中。搜索与思考按钮保持透明，搜索状态点与思考文字颜色表示当前选择。不可用能力不提供可操作入口。
- 小图标保持可读的无障碍名称和至少 40 × 44dp 的触摸区域，当前模型名称在对话页头及选择器中显示。发送、重试、草稿锁定、图片附件和排队／引导的原有业务语义保持一致。
- `BrandIcon` 只负责显示品牌；来源记录在 `assets/brands/README.md`。未知模型使用通用芯片图标。图片和思考能力标签取服务端目录，不根据品牌猜测。
- `ModelPicker` 使用紧凑列表、搜索、供应商筛选和收藏；`ReasoningPicker` 仅显示服务端按当前模型 ID 匹配的选项；仅支持开关的模型显示“关闭 / 开启”，预算档位在说明中列出 token 上限；`SearchPicker` 默认展示开关和已配置服务，添加密钥表单按需展开。
- `MessageBody` 统一普通与财务对话中的 Markdown、表格、链接和可选择文字。用户消息使用右侧中性底色气泡，助手回复留足正文宽度，辅助动作使用图标。
- 设置和管理页优先使用分组列表、行尾操作；不要为每个选项创建一整张卡片和一排通栏按钮。空项目不重复展示图标、空状态和大按钮。

## 连接状态

[`NoticeProvider`](../src/Notice.tsx) 挂在安全区内，集中显示悬浮提示，不占页面布局空间，不拦截提示栏以外的触摸。`useNotice().show()` 支持普通、成功、警告、错误四种语义色、操作按钮及关闭；默认 4 秒后消失，`duration: null` 保留到调用 `dismiss(id)`。传相同 `id` 更新原提示和计时，较新的提示暂时覆盖旧提示，关闭后尚未结束的状态提示重新显示。页面卸载时应撤下自己创建的持续提示。

```tsx
const { show, dismiss } = useNotice();
show({ message: "已保存", tone: "success" });
show({ id: "upload", message: "正在上传", duration: null, dismissible: false });
// 上传结束
dismiss("upload");
```

`ConnectionStatusProvider` 聚合后台读取的状态：同一来源连续失败至少 3 次且持续至少 15 秒才显示一条自动重连提示；短暂失败静默。任一失败来源尚未恢复时保留提示，全部恢复后自动移除。401/403 立即提示检查连接凭证。
同步提示复用共享提示栏，提供重新连接和关闭；关闭后不因同一故障的后台轮询反复弹出，恢复或提示内容变化后再正常处理。日夜主题与大字号随共享主题变化。

页面保留已加载内容和本地草稿；后台轮询的错误不能覆盖发送、批准、模型切换等用户操作的错误。用户操作失败仍立即显示，批准失败不移除待批准项。旧服务端没有批准列表（404）时不持续提示断线。

## 设置入口

底栏原“工具箱”改为两字“设置”，使用齿轮图标；侧栏只保留对话搜索和记忆。
设置首页参考旧版知行 RikkaHub 的 CardGroup 结构，通过 `SettingsGroup` 与 `ActionRow compact`
分为“通用”“模型与服务”“助手”“数据与连接”，通用分组保留日夜外观选择。供应商、默认模型、人格和服务连接分别打开，所有子页与 Android 返回键均回到设置首页。

模型供应商显示品牌、模型数与配置状态，可搜索、新增、编辑、停用和删除。底部弹层分“配置 / 模型”，支持远端模型列表批量添加、手动添加、编辑能力与三项连接测试。密钥仅提交至服务端，表单留空保留原值，清除是显式操作；不将已配置标成已连通。默认模型仍在单独入口选择。
搜索服务复用 `SearchPicker` 的管理模式，支持增删，添加成功留在服务列表；管理入口没有聊天搜索开关，添加时不改动当前选用的搜索服务。移除当前选用的服务后清除对应选择。
