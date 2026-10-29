# 对话详情产品对照：RikkaHub 与知行 DSH

日期：2026-10-29。状态：产品调研与改进建议，**不是本轮功能交付清单**。

知行已经打通 DSH 的基本对话、工具过程、提问、停止、排队、附件发送和恢复。与 RikkaHub 的主要差距，在于用户收到回复以后能否继续处理它：修改原消息、重新生成、比较版本、读懂工具结果、打开文件、选择文字、查找和分享。这些操作构成日常聊天的完整体验，单纯换配色或调整圆角不能补齐。

建议保留现有知行外观，先补“消息操作—执行过程—结果交付”的闭环，再补高级编辑、多媒体和会话组织。DSH 继续负责执行和能力；App 负责把行为、状态和结果呈现清楚，不增加工具白名单、执行轮数或预算限制。

## 1. 对照基线与阅读方式

| 对象 | 本文基线 | 结论范围 |
| --- | --- | --- |
| RikkaHub 正式版 | [3.1.1 官方发布][R-release]，源码 `ad2c4430d50ba52392b2941367f98ef59614cb73`；官方 ARM64 APK | 弹层和布局以正式版为主。Android 16 模拟器实际打开代表界面，其余按同版本源码核对。 |
| RikkaHub 开发分支 | `a5db9c9b770f316c76136970aa01a9d790e10e51` | 只在第 8 节记录发布后变化，不混入正式版实测。 |
| 知行 Next | `main` 的 `03c7b531343136f1b94c117ff456d0087352fceb`，DSH 接入及聊天修正已合入 | 以 `AssistantApp → DshChatPanel` 的真实连接路径为准，不把旧 Python `ChatPanel` 的功能当作 DSH 已有。 |
| 知行运行验收 | [DSH Android 模拟器验收](DSH-ACCEPTANCE-2026-10-29.md) | 独立测试 APK、真实 DSH 宿主、确定性测试模型。不是正式发布、生产迁移或云模型自主开发验收。 |

本文覆盖对话详情，以及直接关联的输入、消息、工具、队列、附件、会话抽屉和子弹层。供应商配置、全局助手编辑、头像编辑、完整工作区管理等独立设置页面不逐字段展开；从聊天进入这些页面的入口仍列明。系统相册、文件选择器和分享面板单独标注，不能当成 App 自绘弹窗。

标记含义：**实测**表示模拟器已打开并观察；**源码**表示入口与实现已确认，未代表真实服务端能力验收；**建议**表示尚待实现。RikkaHub 的语音、MCP、工作区和复杂工具不在本轮云端验收范围。截图里的模型回复是本地构造内容，只用于检查 UI。

## 2. 一屏界面：两边分别做了什么

### 2.1 页面结构

| 区域 | RikkaHub 3.1.1 | 知行当前 DSH | 产品判断 |
| --- | --- | --- | --- |
| 顶栏 | 左侧抽屉；会话标题；小字助手／模型／供应商；消息概览、新会话。已有内容时点标题可改名。 | 助手名为主、话题为副标题；菜单、对话设置、外观、新建、关闭。点标题进入抽屉。 | 知行入口较多，窄屏标题空间有限。保留助手身份，明确话题与模型所在位置；改名、查找、导出可进会话菜单。 |
| 消息阅读区 | 用户右侧气泡；助手可无气泡，也可按偏好显示气泡；头像、名称、时间等可配置。正文与思考／工具按发生顺序混排。 | 用户右侧气泡，最大宽度 88%；助手名称加正文；有序思考／工具分组。 | 主结构接近。差距集中在结果类型和后续操作，不需要推翻现有消息布局。 |
| 输入容器 | 文本在上、操作在下的同一圆角容器，文字最多约 5 行；模型／推理图标在左，加号／语音／发送在右。 | 模型、思考状态在容器上方单独横滑；容器内加号、多行文本、发送同一行；文本高度 54–140dp。 | 知行模型名称更显眼；RikkaHub 留给文字的横向空间更完整。长文本场景应补展开编辑，先保持现有壳子。 |
| 附件草稿 | 横向附件条；图片仍带附件名称，可预览、移除，预览后可进入画板。 | 96dp 纯图片缩略图与角上移除按钮；普通文件分开；多图一次发送。 | 保留知行已有的照片优先方案，不把图片退回文件名卡片。 |
| 生成状态 | 消息过程、底部生成指示、可选触感；空输入时发送变停止；有输入时可继续排队。 | 消息内“正在回复／使用工具／等待回答”等状态；空输入时停止；有内容可排队或补充当前回复。 | 基本方向一致。接下来应让等待、失败、停止和恢复的状态更准确、可操作。 |
| 快速导航 | 消息概览带当前对话搜索；可跳到某条消息；可选首条／上条／下条／末条跳转控件。 | 向上阅读时暂停跟随，提供回到最新；抽屉可全局搜索，但 DSH 没接命中消息定位。 | 长对话应先补查找和准确定位，再考虑更多跳转按钮。 |

来源：[RikkaHub 页面][R-page]、[输入区][R-input]、[消息列表][R-list]；知行 [页头][Z-header]、[输入区][Z-composer]、[DSH 对话][Z-dsh]。

### 2.2 视觉尺度与交互风格

| 维度 | RikkaHub | 知行当前 | 建议 |
| --- | --- | --- | --- |
| 视觉系统 | Material 3 Expressive；主题语义色、浅色容器、分段圆角列表、图标形状变化。 | 日间白底／朱红／金色，夜间近黑／炭灰／暗金；统一主题与共享组件。 | 借鉴层级、密度和反馈，不复制其紫色、图标或整套组件。 |
| 普通底部弹层 | Material ModalBottomSheet；遮罩、顶部手柄；多数只在隐藏和展开两态之间切换。 | 28dp 顶部圆角；32×4dp 手柄；标题、副标题、44dp 关闭按钮；遮罩／返回／拖柄关闭。 | 现有基础足够复用。选择器、动作菜单、详情分别定义内容结构。 |
| 弹层高度 | 模型约占可用内容区 80%；扩展 75%；MCP 70%；短菜单随内容；复制选择接近全屏。 | 默认随内容；`tall` 为屏高约 74%，同时受键盘与安全区约束；最大宽 600dp。 | 不把所有内容固定为同一高度。复制长文、文件和代码使用足够大的阅读区域。 |
| 加号入口 | 图标 28dp；附件入口最小高 88dp；一排最多四个，更多时分行。 | 两个等宽 88dp 入口：“照片”“文件”。 | 可逐步补相机；复杂能力采用分组列表，避免所有插件挤成图标墙。 |
| 正文与间距 | 消息列表水平约 16dp、消息间 12dp；字号可配置；工具信息视觉降级。 | 正文 15sp／24 行高；标题、引用、表格和代码共用 Markdown 样式。 | 先检验中文长文、宽表格、大字号，再决定数值调整。不能只按英文样例评估。 |
| 操作按钮 | 常用消息动作是紧凑图标；发送可见圆形约 30dp；部分消息按钮显式取消最小触摸尺寸。 | 消息、附件等主要触摸目标 44dp 左右；发送 46dp。 | 保留知行触摸目标优势，不能为了“像”而缩小可点击区域。 |
| 动效 | 弹层子页横向切换，分组展开、正文尺寸变化、选中形状与触感反馈。 | 弹层打开 260ms／关闭 190ms，尊重减少动态效果；正文按语义块复用。 | 动效服务于状态可理解；长文生成时不抢滚动，低性能设备不掉帧比装饰更重要。 |

以上 dp 来自源码配置，不是用截图反推的像素规格。知行视觉约束继续遵循 [共享 UI](UI.md)。

## 3. 功能对照：已有、部分接入与缺口

### 3.1 发送与阅读

| 功能 | RikkaHub | 知行 DSH 现状 | 差距／取舍 |
| --- | --- | --- | --- |
| 文本与流式回复 | 支持；用户读历史时有滚动跟随控制。 | 已有，模拟器验证历史停留和回到最新；当前以 750ms 游标轮询取得增量。 | 不把轮询频率当作实测延迟指标；后续测首字、滚动和掉帧，再决定传输优化。 |
| Markdown | 标题、列表、引用、表格、代码；LaTeX、Mermaid；HTML／SVG 代码可预览。 | 基础 Markdown、横滑表格、代码语法高亮、未完成 Markdown 补齐已接；无公式、Mermaid、HTML／SVG 预览。 | 按实际结果补渲染器，首先满足代码维护和报告阅读。 |
| 代码块动作 | 语言、复制、保存文件、折叠；支持的语言可预览。 | 依赖库有复制能力，但 `MessageBody` 未传 `onCopyCode`，当前没有代码块单独复制按钮；可复制整条消息。 | 低成本高价值：先接代码块复制，再补保存／预览。 |
| 表格动作 | 表格有独立标题栏、复制与 CSV 下载；复制优先保留 Markdown 表格，无原文时用 CSV。 | 表格可横滑，无独立复制和导出。 | 财务与统计结果可直接复用，避免用户逐格抄数据。 |
| 文字选择 | 正式版生成结束后启用选择；另有“选择并复制”大弹层。 | 稳定正文可选，流式关闭选择；无独立选择全文面板。 | 支持局部复制，避免只能复制整条长文。 |
| 图片 | 草稿预览、缩放查看、保存；消息图片点击放大。 | 草稿多选、移除、全屏左右翻图；历史图片两列显示，认证读取已验收。 | DSH 图片预览没有缩放、保存／分享操作；旧 Resource 图片的分享不能算作这里已有。 |
| Markdown 远程图片 | 有图片渲染组件。 | Markdown 图片节点只显示 alt 文本；原生附件图片走另一条已接通路径。 | 必须区分“图片附件能看”和“正文里的图片能看”。 |
| 普通文件 | 消息文件 chip 可调用系统打开；工作区编辑文件有导出／分享。 | 发送与持久草稿已接；DSH 历史文件只显示名称，无打开／下载按钮。 | **关键缺口：结果传来了，但用户不能直接取用。** |
| 相机／画板／裁剪 | 相机；单图可裁剪；画板可写画、撤销重做和在图片上标注。 | 独立入口仅照片／文件；无这些 App 自有编辑能力。 | 相机优先于复杂画板；多选照片不应强制逐张裁剪。 |
| 音频／视频附件 | 特定供应商条件下显示专用入口；消息可调用系统播放。 | 无专用录制、播放器与输入能力提示；选作普通文件不等于多模态已支持。 | 按宿主／模型能力呈现，不假设所有模型都支持。 |
| 语音输入／语音对话 | ASR 可把转写补到原草稿；配置完成后可进入持续语音模式，有连接、聆听、转写、等待、播报、错误状态。 | DSH 对话无麦克风和持续语音入口。 | 后续独立切片，不与最先的消息操作修复捆绑。 |
| 朗读／翻译 | 助手回复可朗读、停止；翻译先选语言，译文保留在原文下方并可折叠、清除。 | DSH 消息菜单未接；旧 `ChatPanel` 有朗读，不能计入。 | 朗读可复用客户端基础，但仍需接通 DSH 文本与生命周期。 |
| 长文本编辑 | 聚焦输入后可展开近全屏编辑；快捷短语、工作区路径补全、长粘贴转文件均有条件支持。 | 多行输入与本地草稿；无展开、短语、路径补全、长文本转文件。 | 先补展开编辑和光标保留；高级能力按使用场景推进。 |
| 草稿与重试 | 有输入状态、编辑附件保护；本轮未做冷启动及回执丢失对等测试。 | 文字、图片、文件草稿恢复；失败保留；已接收上传不重复；丢回执重试不重复提交已实测。 | 保留现有可靠性，不因为重做外观而回退。 |

来源：[富文本][R-markdown]、[代码块][R-code]、[图片预览][R-image]、[附件选择][R-attachment]、[语音状态][R-voice]；知行 [正文][Z-body]、[照片][Z-photo]、[DSH 对话][Z-dsh]。代码块复制判断同时核对锁定依赖的 `FenceBlock` 实现，不能仅看已有样式名。

### 3.2 消息操作与会话组织

| 功能 | RikkaHub 的实际语义 | 知行 DSH 现状 | 建议 |
| --- | --- | --- | --- |
| 编辑原消息 | 用户气泡点击或消息菜单进入编辑；保留消息位置，普通消息保存成原节点的新版本。**保存编辑本身不自动重新生成。** | “修改后重新发送”仅把原文追加到草稿；最终作为新消息发送，不改原记录，不携带原消息附件。 | 命名要匹配行为。真正的编辑／从这里重答必须由宿主语义支撑。 |
| 重新生成 | 助手消息在同一节点新增回答分支；从用户消息重答会移除之后节点，因此有确认。 | 无专用入口与插件接口。 | 需要先核对 DSH 原生支持，不能在 UI 隐藏旧回复冒充重答。 |
| 版本切换／分叉 | 同一节点显示版本切换；可从选定消息创建独立会话，并复制相关附件。 | 无版本切换或从消息分叉。 | 代码修复方案比较是明确场景，可排在编辑与重答之后。 |
| 删除消息 | 删除当前版本；无其他版本时删除整个节点；生成中阻止删除。 | 无消息删除入口。 | 明确影响上下文和显示的范围，再定义交互。 |
| 复制／引用 | 快速复制；选择并复制；编辑等入口分层。 | 复制有反馈；助手“引用到草稿”加文字前缀；不是带消息关联的引用块。 | 保留快速动作；若做关联引用，需要可回到来源且不重复粘贴大段全文。 |
| 分享／导出 | 消息菜单进入多选，可选 Markdown 或长图，并控制是否包含思考。 | 无对话片段分享、Markdown 导出或长图导出。 | 先做选定消息的文字／Markdown 分享，再评估长图。 |
| 收藏 | 消息可收藏，在抽屉进入收藏页。 | 无 DSH 消息收藏。首页固定会话属于另一种能力。 | 不把“收藏消息”和“固定会话”混成一个状态。 |
| 会话标题 | 点击标题改名；抽屉长按可重新生成标题。 | 创建时可设标题；详情没有改名入口和对应更新接口。 | 补简单的会话改名，避免大量不易辨认的话题。 |
| 查找与定位 | 当前对话概览可搜索并跳到消息；还有全局历史搜索。 | 抽屉搜索、命中片段可用；DSH 打开结果只到会话，未传入命中消息定位。 | 先补“找到后到达原位置”，否则搜索闭环不完整。 |
| 分组／移动 | 会话置顶、文件夹、移动到助手；助手选择有标签筛选。 | 抽屉分“7 天内／更早”，新建、搜索、记忆；无会话文件夹／移动菜单。 | 属于次一级组织能力；先保证已有会话找得回。 |

来源：[消息动作][R-actions]、[版本数据语义][R-versions]、[重新生成与编辑服务][R-service]、[导出][R-export]、[抽屉][R-drawer]；知行 [DSH 对话][Z-dsh]、[抽屉][Z-drawer]、[分支接入位置][Z-app]。

### 3.3 Agent 行为与结果

| 功能 | RikkaHub | 知行 DSH 现状 | 对知行的要求 |
| --- | --- | --- | --- |
| 思考与工具 | 按发生顺序分组、折叠；工具可有摘要、图片、耗时、错误、审批与问答。 | 有序正文／思考／工具；运行时看最近两步，完成后默认收起；可展开全部。 | 保留轻阅读体验；需要用户处理的事项不能藏在折叠历史里。 |
| 工具详情 | 根据工具类型展示：搜索结果、文件内容、修改 diff、命令输出；未知工具回退到输入／输出。 | 主界面映射中文工具名与状态；详情仅通用状态说明，再进入原始记录看参数和结果。 | 增加摘要、输入、输出、耗时、错误、附件；原始记录作为次级排查入口。 |
| 未知插件 | 注册专用渲染器；无渲染器时显示通用工具详情。 | 原始事件和未知字段保留；主过程标题可能只有“使用工具”。 | **渲染器缺失不能成为执行限制。** 显示宿主名称和通用内容，让新插件可用。 |
| 提问 | 单选／多选／文本；多题全部有答案才可提交；回答后在工具步骤保留结果。 | 已接 DSH 原生问答、选项说明和自定义回答；实际问答后继续执行已验收。 | 补忙碌、过期、重复提交和重开会话的状态验收；保持宿主问题语义。 |
| 授权 | 工具内批准／拒绝；拒绝可写原因。 | DSH 审批卡显示工具名与原因，“允许这一次／拒绝”；没有拒绝原因输入。 | 先展示准确操作与范围，再映射宿主支持的决策。不增加 App 自己的授权制度。 |
| 队列 | 输入区上方队列面板；数量、暂停／恢复、编辑、移除；编辑时锁住对应条目。 | 队列悬浮摘要与列表；可撤回或补充当前回复。插件已有 `edit` 路由，UI 未提供编辑。 | 优先补队列编辑、附件摘要和确认状态；区分队列与正在执行的任务。 |
| 停止 | 可停止生成；取消的工具有结果状态处理。 | 实际 Shell 退出、未发生延迟写入、原生 aborted 回执已验收。 | 维持真实回执标准，不仅换成一个“已停止”标签。 |
| 模型与推理 | 模型搜索、收藏排序、供应商折叠／快速定位；推理滑条。 | 复用模型搜索／收藏／供应商筛选；推理只显示宿主目录返回的档位，选择后提交宿主。 | 保留真实能力来源；不要照抄固定七档而虚构模型能力。 |
| 搜索、MCP、扩展 | 加号内可选搜索模式、MCP 服务器、快捷短语／提示注入／世界书／技能。 | 详情未接这些配置面板；宿主页面可管理插件等。 | 区分“宿主能用”和“App 能配置”。配置不应成为普通聊天前置流程。 |
| 工作区与压缩 | 工作区／当前目录、路径补全；压缩时可加要求并保留若干最近消息；有上下文用量提示。 | 使用宿主工作目录；App 未显示选择器、上下文用量、压缩操作。 | 先解决当前任务“在何处做、做成什么”，再提供按需配置入口。 |

来源：[工具步骤与审批][R-tools]、[专用工具展示][R-tool-renderers]、[队列][R-queue]、[模型选择][R-model]、[推理][R-reasoning]、[加号菜单][R-plus]；知行 [回复展示][Z-reply]、[协议投影][Z-protocol]、[插件接口][Z-plugin]。

## 4. 弹窗、弹层与对话框逐项清单

这部分描述界面的入口、形态、内容、操作和退出。**同一底部弹层中的子页不等于又叠一层弹窗；内联卡片和独立页面也明确标出。** “无”仅指当前知行 DSH 对话入口，没有否定宿主本身的能力。

### 4.1 输入区、模型与扩展

| 编号／入口 | RikkaHub 样式与内容 | 操作、状态与关闭 | 知行对照 |
| --- | --- | --- | --- |
| A01 加号主菜单 | 底部弹层，手柄；上部相机／照片／画板／文件大图标宫格，下部分段列表：联网、工作区、当前目录、MCP、扩展、压缩；按配置显示条件项。[R-plus] | 附件选择成功回草稿；子设置在同一个 sheet 内进入；遮罩／返回退出。 | **实测**：带标题、关闭按钮的“添加到消息”，仅照片／文件两个块。 |
| A02 模型选择 | 约 80% 高弹层；顶部圆角搜索，收藏分组、供应商可折叠组、模型标识／能力／选中状态；底部供应商导航。[R-model] | 选中后关闭；收藏不关闭；收藏可拖排序；底部供应商 chip 是跳转定位，不是过滤器。 | **实测／源码**：74% 高，搜索、收藏、供应商过滤、选中边框；等待宿主保存成功才关闭，失败留层。无收藏排序／组折叠。 |
| A03 推理深度 | 底部弹层；大图标及当前档位／说明；七档离散滑条，形状随档位变化。[R-reasoning] | 拖动预览，松手提交，触感反馈；不自动关层。 | 56dp 灯泡图标、档位点选、模型默认／自动；提交成功关闭；档位来自宿主。交互不同但无需强行统一为滑条。 |
| A04 联网模式 | 加号子页；返回箭头、标题、大状态图形与说明；关闭／本地搜索服务／模型内置搜索分段选择。[R-search] | 模型内置选项按供应商支持显示；可再进服务选择，返回回主菜单。 | DSH 详情没有搜索选择器；旧链路 `SearchPicker` 不能计入。 |
| A05 搜索服务选择 | 加号内的下一层子页；服务列表与当前项，带管理入口。[R-search] | 选服务后回到相关选择流程；管理入口关闭弹层后进设置。 | 当前通过宿主配置；后续只呈现宿主实际提供的选择。 |
| A06 MCP 选择 | 约 70% 高子页；返回、标题、同步进度；服务器分段行、状态文字、工具数和开关。[R-mcp] | 整行切换；连接中、重连、授权中、错误、需授权分别显示；返回主菜单。 | 无原生面板；不要把未渲染当作 MCP 被禁用。 |
| A07 扩展选择 | 约 75% 高子页；返回、标题；快捷短语／模式提示／世界书／技能四个标签页；行尾开关、数量和空态管理入口。[R-extensions] | 切换即更新；可横滑标签；管理跳独立页并关闭菜单。 | 无；DSH 插件与 RikkaHub 扩展分类并非一一对应，应按 DSH 数据组织。 |
| A08 工作区选择 | 底部弹层；标题，不绑定、工作区名称／状态／选中标记；底部管理入口。[R-workspace] | 选中后关闭；管理转独立页；不绑定是显式状态。 | 对话设置提供宿主配置说明；返回有效 `web_url` 时可打开 DSH。未展示当前工作区详情。 |
| A09 当前目录选择 | 底部弹层；标题与说明，上级目录按钮、当前路径、文件夹列表，底部重置／设为当前目录。[R-cwd] | 可逐级浏览；确认后关闭；目录为空有说明。 | 无；代码维护场景需要知道实际目录，配置仍遵从宿主。 |
| A10 压缩历史 | 居中 AlertDialog；标题、解释，可选多行附加要求，“保留最近消息数”减／数值／加；取消／确认。[R-compress] | 最小 0；执行中 spinner 替换表单、禁止外部误关；取消可取消压缩任务。 | **RikkaHub 实测静态弹窗**；知行无压缩入口、用量或摘要检查点展示。 |
| A11 长文本展开编辑 | 底部对齐的近全屏 Dialog，约 90% 高，顶部圆角 16dp，右上保存，大文本框，避开键盘。[R-input] | 与草稿共享文本状态；保存／返回收起，不能把“保存”误解为发送。 | 无；这是写需求、贴代码时应先补的编辑工具。 |
| A12 快捷短语 | 锚定输入区的 DropdownMenu，约 200–360dp 宽；标题及内容预览。[R-input] | 选中追加草稿；菜单关闭，不直接提交。 | 无；可后置。 |
| A13 路径补全 | 输入附近候选浮层，候选数受限；显示工作区文件／路径。[R-input] | 随输入触发，选择替换对应输入片段。 | 无；先确认 DSH 可提供目录，再接 UI。 |

### 4.2 附件与多媒体

| 编号／入口 | RikkaHub 样式与内容 | 操作、状态与关闭 | 知行对照 |
| --- | --- | --- | --- |
| B01 相册／文件／相机 | Android 系统选择器或相机 Activity；权限对话框由系统提供。[R-attachment] | 成功选取后入草稿；取消不提交消息。单图是否进裁剪由偏好决定，多图直接加入。 | 照片／文件系统选择器已实测；无专用相机入口。 |
| B02 图片裁剪 | 全屏 Dialog；图片移动／缩放、拖动裁剪框；旋转 90°、重置、比例选择、关闭、确认。[R-crop] | 裁剪中避免重复提交／误关；失败提示；结果写入草稿。 | 无；建议可选编辑，不打断默认多图发送。 |
| B03 图片预览 | 全屏图片浏览 Dialog；可缩放、翻图；底部保存；草稿图片额外有画板入口。[R-image] | 系统返回退出；保存期间进度提示，结束给成功／失败反馈。 | 深色全屏、关闭、页码、左右翻图已实测；DSH native image 不显示分享按钮；无缩放／保存。 |
| B04 画板 | 全屏 Dialog；顶部关闭／选图／撤销／重做／确认，中间画纸，底部工具；调色面板浮在画纸上。[R-sketch] | 画纸不随键盘改变尺寸；确认生成附件；草稿图标注可替换原图而保持位置。 | 无；后置，保留现有照片流。 |
| B05 画板文字输入 | 居中短表单 Dialog，文本字段、取消／确认。[R-sketch-text] | 确认后文字落到指定画布位置；取消不改变图。 | 无。 |
| B06 放弃画板修改 | 居中确认 Dialog，说明会丢弃绘制，取消／确认。[R-sketch] | 空画板直接退出；有绘制时返回或关闭才出现。 | 无；这是有实际丢失风险的确认，不应推广成所有弹层必确认。 |
| B07 文件打开／系统分享 | 文档 chip 调系统打开；音视频调系统播放器；分享产生 Android chooser。[R-message] | 实际能否打开取决于 MIME 与设备；不能保证每类文件都有系统接收应用。 | DSH 文件名称未接打开；旧 ResourcePreview 的预览／分享不能算作原生 DSH 文件完成。 |

### 4.3 消息与阅读操作

| 编号／入口 | RikkaHub 样式与内容 | 操作、状态与关闭 | 知行对照 |
| --- | --- | --- | --- |
| C01 消息更多 | 底部动作菜单；分段行：选择复制、WebView、编辑、分享、分叉、收藏、删除；删除用错误色；底部时间／模型。[R-actions] | 文本为空时隐藏不适用项；选择动作后收起或进入后续流程。生成中最后一条消息的操作受限。 | 消息操作底部弹层只有复制、引用／修改到草稿、处理记录；没有内容版本、删除、导出等。 |
| C02 选择并复制 | 全高底部弹层，无拖柄，禁用 sheet 拖动，避免与文字选择冲突；顶栏关闭／标题／复制全部，正文独立滚动。[R-copy] | 可选原始文本；关闭返回原位置；复制全部不等于选择后发送。 | 无；当前只能在消息里选择或复制整条。 |
| C03 从用户消息重答 | 居中确认对话框，说明重新生成行为。[R-actions] | 用户确认后移除后续节点再生成；助手重答在原节点新增分支，走不同语义。 | 无。建议若宿主行为不同，文案必须跟随实际影响。 |
| C04 编辑消息状态 | **内联编辑栏，不是弹窗**；输入区显示正在编辑、取消，内容／附件回填，适用时可改未签名思考文本。[R-input-state] | 保存为消息版本；取消退出编辑；原附件不会因取消编辑被删除。 | 仅追加文字到普通草稿，无专门编辑态。 |
| C05 翻译语言 | 底部弹层；标题、带语言图标的圆角列表卡、清除翻译。[R-translation] | 选择后翻译；译文附于原文下，标题与折叠按钮、生成状态；清除只清译文。 | DSH 无；避免把翻译覆盖原文。 |
| C06 分享消息选择 | **列表选择态＋底部浮动工具条**；从当前消息向前预选，可调整、全选／清空、确认。[R-list] | 确认后再进导出格式；退出不改原对话。 | 无多选消息态。 |
| C07 导出格式 | 底部弹层；是否包含思考开关；Markdown 卡与图片卡；图片内控制是否展开思考等。[R-export] | 生成文件后进入系统分享／保存流程；需等待完成反馈。 | 无；优先让选择范围和导出内容一致。 |
| C08 WebView／HTML／SVG／Mermaid 预览 | **独立预览页面，不是普通菜单**；由消息 WebView 或代码预览进入，代码仍可切回查看。[R-code] | 返回原对话；代码可复制／保存，Mermaid 可导出图片。 | 无对应预览；Markdown 中的普通链接交系统浏览器。 |
| C09 已编辑文件动作 | 底部弹层；文件名、导出／分享两个大行；回复后文件 chip 进入，多文件可“更多”。[R-edited-files] | 导出调系统创建文档，分享先准备实际文件；不是只复制文件路径。 | 无 DSH 产物动作；这是代码维护和日常报告的共同缺口。 |
| C10 消息版本切换 | **内联左右切换器与版本序号**。[R-actions] | 改变当前版本，不新建聊天；从这里分叉则新建独立会话。 | 无；需要版本关联数据，不能由前端拼假编号。 |
| C11 用量详情浮层 | 点击回复下方统计行打开上方 RichTooltip；上下文占用条、缓存／输入／输出、步数、速度、耗时，按实际数据显示。[R-usage] | 偏好关闭或无用量数据时不出现；是按需查看的说明浮层。 | 无 DSH 对话用量浮层；原始事件不等于已整理的统计，不显示虚构费用或速度。 |
| C12 朗读控制浮窗 | 圆胶囊浮动控制器；播放／暂停、关闭，展开后有速度和快进，播放／缓冲状态有进度环。[R-tts] | 关闭会停止朗读；不是每条消息各弹一个全屏播放器。 | DSH 未接朗读，更没有对应控制器；旧链路朗读需单独迁移验证。 |

### 4.4 工具、等待与错误

| 编号／入口 | RikkaHub 样式与内容 | 操作、状态与关闭 | 知行对照 |
| --- | --- | --- | --- |
| D01 工具详情 | 底部弹层；已识别工具专用内容：搜索结果、文件正文、代码 diff、Shell 命令／输出／退出结果；未知工具显示参数与返回。见[工具步骤][R-tools]、[专用渲染][R-tool-renderers]。 | 可滚动、选择和复制适用内容；关闭回原消息。 | 通用“已完成／未完成”说明＋查看处理记录；缺少直接可用结果。 |
| D02 拒绝原因 | 居中 AlertDialog；可选 2–4 行原因、取消／拒绝。[R-tools] | 原因随拒绝回传；没有输入原因也能拒绝。 | 直接拒绝，无原因字段；须按宿主协议扩展。 |
| D03 工具提问／审批 | **消息内卡片／步骤**；问题、单／多选、文本、提交；审批单独允许／拒绝。[R-tools] | 必答题有值才提交；回答后保留结果；生成状态不能掩盖待处理项。 | 问答／审批卡已接；问答实际执行已验收。完整审批组合仍需专项回归。 |
| D04 队列面板与编辑 | **输入区上方内联队列**，标题数量、暂停／恢复、条目摘要与编辑／删除；编辑另开居中 Dialog。[R-queue] | 编辑对话框含附件预览与 3–8 行输入；取消／保存；编辑锁防止队列同时消费该条。 | 悬浮一行摘要＋“等待发送”底部列表；撤回／引导已有；UI 无编辑，虽然接口已支持 edit。 |
| D05 错误反馈 | 底部浮动错误卡，标题、原因、复制、关闭；多条可清空，源码设为约 5 秒后自动消失。[R-error] | 部分错误提供设置跳转；生成失败会暂停队列等待用户处理。 | 对话错误文案／重试、同步状态、原始回执。重要发送失败应持续可见，不必照抄自动消失。 |

### 4.5 会话与抽屉

| 编号／入口 | RikkaHub 样式与内容 | 操作、状态与关闭 | 知行对照 |
| --- | --- | --- | --- |
| E01 会话抽屉 | 左侧抽屉＋右侧遮罩；历史、搜索、分类、会话列表、助手与底部功能入口。[R-drawer] | 点遮罩／返回关闭；选会话切换；会话行可长按。 | **实测／源码**：86% 宽、最大 380dp；搜索、记忆、7 天内／更早、更多、新建；无长按管理菜单。 |
| E02 改会话标题 | 居中 AlertDialog；单行输入，取消／保存。[R-page] | 有消息时点标题进入；空会话不进入正常改名流程。 | 无；点标题打开抽屉。 |
| E03 会话长按菜单 | 锚定会话行 DropdownMenu：置顶、重生成标题、移动到助手／文件夹、删除。[R-conversation-list] | 执行动作后关闭；3.1.1 此处删除会话直接调用删除，不能假定还有确认弹窗。 | 无；建议危险影响明确、支持恢复时优先撤销。 |
| E04 移动到助手 | 底部弹层，目标助手列表与标识。[R-drawer] | 选后移动并关层；属于组织变更，不是临时切模型。 | 无。 |
| E05 移动到文件夹 | 底部弹层，未分类项及文件夹；列表有当前项状态，内容高度受限可滚动。[R-drawer] | 选目标即移动；取消不改动。 | 无。 |
| E06 新建／重命名文件夹 | 居中 AlertDialog，单行名称，取消／保存；空名称不可保存。[R-drawer] | 原地创建或改名，不影响消息内容。 | 无；两种操作复用同一表单样式。 |
| E07 删除文件夹 | 居中确认 Dialog；文件夹名和影响说明，取消／删除。[R-drawer] | 仍有生成中的会话时可能阻止并提示。 | 无；先不要为对话体验建设完整文件夹系统。 |
| E08 文件夹操作／排序 | 小型 DropdownMenu，靠近文件夹或排序入口；文件夹重命名／删除及会话排序选择。[R-drawer] | 选中即应用；菜单外点击关闭。 | 无可比菜单；抽屉只做时间分组。 |
| E09 助手切换 | 约 80% 高底部弹层；标题、可选标签过滤、头像与助手列表。[R-assistant] | 选中后关闭；配置跳独立助手设置页。 | 通过主知行／服务专用助手进入；DSH 详情无通用助手切换器。 |
| E10 当前对话搜索／概览 | **同页模式切换**；顶部搜索，消息摘要列表，用户／助手不同对齐和容器色。[R-list] | 点击命中回正文并定位；清空查询恢复列表。 | 无当前对话概览；全局搜索到 DSH 消息的定位缺口仍在。 |
| E11 当前会话系统提示 | **内联可展开编辑卡**，按助手设置允许；编辑、重置、保存。[R-system] | 仅影响当前会话配置，生成中不显示编辑入口。 | 无；不能自行发明与宿主冲突的系统提示优先级。 |

### 4.6 知行已有、需要继续保留的专属弹层

| 编号／入口 | 当前内容与样式 | 改进方向 |
| --- | --- | --- |
| Z01 对话设置 | 通用 BottomSheet；本条发送方式“接着处理／补充当前回复”、运行时停止、完整处理记录、DSH 宿主配置说明；有效 `web_url` 存在时提供打开入口。 | 发送方式做明确选项和选中状态，文案解释生效对象；目前是组件局部状态，不应宣称继承全局持久默认。 |
| Z02 处理记录 | 74% 高 BottomSheet；原始事件与工具回执；逐项“查看详情”展开 JSON，可选择文字。 | 保留可追溯性，但普通工具详情、文件交付不应依赖用户阅读 JSON。 |
| Z03 外观 | BottomSheet；跟随系统／白天／夜间三张预览卡，单选、即时生效、错误说明。 | 保留主题与草稿不重置；以后可将入口集中到不占用窄屏顶栏的位置。 |
| Z04 等待发送 | BottomSheet；条目文字、下一步补充／当前回复完成后处理的说明，撤回与引导。 | 补附件摘要、编辑、操作进行中／失败；服务端更新成功后才反映已完成。 |

知行相关来源：[统一弹层][Z-sheet]、[对话弹层][Z-dsh]、[外观][Z-appearance]。本节共列 **52 个界面条目**，包括不同用途的弹层、复用表单、系统界面与明确标出的内联／页面状态；并不声称有 52 个独立 Modal 组件。

## 5. 关键细节：验收时不能只看“点得开”

### 5.1 输入、键盘与返回

- 文本、照片、文件是同一条草稿；添加、预览、切换模型和退出弹层不能误发或清空内容。
- 长文本展开编辑保留光标、选择范围和未发送内容；“收起／完成编辑”与“发送”必须是不同动作。
- 输入状态至少区分可编辑、正在发送、提交结果待确认、生成中可追加、正在停止。重试沿用同一个请求，不重新制造消息。
- 普通选择弹层可点遮罩／返回关闭；编辑的有损操作按实际风险保留草稿或提示。不要让从子页返回等同退出整个聊天。
- 图片、文件选择器应在自绘弹层退场后再打开；当前知行已做此交接，需保留。
- 320dp、键盘展开、大字号和横屏时，内容应可滚动；关闭／确认不能落到屏外。

### 5.2 阅读与流式

- 自动跟随只在用户位于末尾时发生。手动上滑后，正文增量、工具展开、键盘收放都不能把人拉回底部。
- 思考、工具、正文按实际顺序展示；完成后默认收起过程，用户主动展开的选择保留；没有思考事件就不造一段“思考中”。
- 等待回答或批准必须显著可见；折叠过程也能找到待处理入口。停止／断线／失败不要都写成“已完成”。
- 代码、宽表格局部横滑，不能把整条消息撑出屏幕；稳定正文支持选词，独立复制面板不与拖动关闭竞争手势。
- 图片、文件、链接、引用、diff 的降级内容应可理解；不支持的专有展示仍有通用读法和宿主入口。

### 5.3 操作结果与恢复

- 编辑、引用、重新生成、重试发送是四种不同动作，文字和回执各自准确。RikkaHub 的“编辑保存版本、另行重答”也不等于 ChatGPT 的所有交互，不能混称为同一标准。
- 工具完成意味着收到完成回执；展示“修改了文件”还应能看到文件或 diff，“生成了报告”应有可打开的报告。
- 文件导出／分享要准备真实字节；仅显示路径、回一个 URL 或弹出成功提示都不算完成。
- 队列撤回必须确实阻止执行；引导必须进入对应运行；队列编辑与消费存在竞态时，保留用户修改并明确结果。
- 断线仍可读已缓存内容；恢复后补齐进度；已提交但丢回执的消息不能重复运行。当前知行已有专项验收，应作为后续改动的回归底线。
- 字号、图标、触摸区域、屏幕阅读器标签、选中／禁用状态需要同时验收。视觉上小的图标可以保留较大的触摸区域。

## 6. 知行产品方案与优先级

以下是建议的实施顺序，不表示已获批的排期或已实现。每个切片先完成一个能实际使用的场景。

### P0：回复之后能继续把事情做完

| 切片 | 具体交付 | 完成标准 |
| --- | --- | --- |
| P0-1 工具与文件交付 | 工具摘要＋详情；read 正文、edit diff、bash 输出／退出结果；未知插件通用详情；文件打开、下载／分享。 | 用户在聊天中提出改文件要求，能看改动、实际命令结果、取得文件；不用先去原始记录找 JSON。 |
| P0-2 消息修改与重新回答 | 保留现有引用；新增真正编辑／重答所需的宿主能力映射；原消息、版本和后续上下文关系明确。 | 改错一句要求后，从明确位置得到新回复；旧结果可辨认；没有把追加一条消息伪装成编辑。宿主不支持的部分应明确拆出。 |
| P0-3 长文阅读与复制 | 代码块复制、独立选择复制、展开输入编辑；中文长文、表格和长代码的稳定滚动。 | 复制某段代码即得到那段代码；选文不拖走弹层；编辑长需求能保留内容与光标。 |
| P0-4 查找与会话识别 | 会话改名；全局搜索命中后准确跳到消息；返回保留原位置。 | 用户能找到上周讨论的具体一段并继续，不需要重新翻整条聊天。 |

P0 的场景主线是：**提出一个小改动 → 看进展 → 回答必要问题 → 看 diff 和测试结果 → 拿到产物 → 纠正要求后继续。** 这与“让知行维护自己的代码”的方向相连，但 UI 补齐本身不能证明自主开发闭环已经成立。

### P1：让连续对话自然、可管理

| 切片 | 具体交付 | 完成标准 |
| --- | --- | --- |
| P1-1 队列完善 | 编辑等待消息、附件摘要、暂停／恢复或等价宿主状态、撤回／引导反馈。 | 排队时能改错字／移除附件，消费竞态不丢修改、不多执行。 |
| P1-2 常用消息动作 | 朗读、翻译、分享选定消息／Markdown；按真实需求增加收藏。 | 原文与译文分开；切会话能停止声音；分享范围可确认且内容完整。 |
| P1-3 图片与拍摄 | 相机入口；图片缩放、保存／分享；可选裁剪。 | 两张图与一段文字仍一键提交；所有操作失败都保留草稿。 |
| P1-4 当前会话能力 | 显示当前目录、模型、实际可用插件／搜索状态，按宿主能力提供按需修改入口。 | 状态与 DSH 一致；无配置时有清楚说明；不能因 App 未做专用 UI 而删掉宿主工具。 |
| P1-5 版本与导出 | 回答版本切换、从消息分叉、长图导出。 | 版本来源、分叉边界和附件归属正确；导出不漏选定内容。 |

### P2：有明确场景后再扩展

持续语音、音视频专用输入、画板、路径补全、更多模型收藏管理、文件夹／助手标签、复杂 HTML／SVG 预览等分开推进。LaTeX／Mermaid 可根据真实回复频率提前，不必等完整多媒体体系。上下文用量与压缩需要宿主的可靠数据和操作支持，不以估算数字冒充真实 token 余量。

### DSH 接入原则

1. 展示层映射宿主已有的会话、事件、问题、工具、队列和产物。能力清单与权限以宿主为准。
2. 常用工具做专用结果 UI；未知工具保留名称、输入、输出、状态与宿主原页入口。新增渲染器不需要同时修改能力白名单。
3. 模型、搜索、插件、目录的配置是否支持会话级修改，先查实际宿主接口。未提供的功能可在插件中增加必要接口，但不能把 UI 按钮当作已经支持。
4. 不把 RikkaHub 的本机供应商密钥、工作区存储或提示词体系直接搬进知行。现有知行模型密钥仍在服务端。
5. 旧业务可继续复用，但必须逐项接回。旧代码里存在朗读、报告预览、搜索选择和全局发送偏好，不等于 DSH 已完成集成。

## 7. 后续实施的模拟器验收清单

本节是**未来验收标准**，不表示此次全部执行通过。

| 场景 | 操作 | 必须看到的结果 |
| --- | --- | --- |
| 基础对话 | 中英文、多段长文、列表、宽表、代码分段生成 | 格式稳定，正文不丢；向上读历史不被拉回；末尾可快速到达。 |
| 长输入 | 输入长需求，展开、选择、收起，再切模型 | 文字、光标和附件保留，未触发发送。 |
| 消息编辑 | 修改早期用户消息并重答，再切回答版本 | 位置／版本／后续上下文与宿主一致；旧回答不被无提示覆盖。 |
| 代码复制 | 复制一个代码块与一段正文 | 剪贴板分别等于所选内容；反馈准确；代码不带无关说明。 |
| 工具链 | read → edit/write → bash，包含一次失败 | 能读文件、看 diff、读错误及退出结果；失败不标成功。 |
| 未知插件 | 执行一个没有专用展示的测试工具 | 能运行；通用详情可读；没有因为前端不认识而拒绝。 |
| 结果文件 | 生成文本、图片、PDF，再打开／保存／分享 | 取得实际正确文件；鉴权与所属会话检查保持；不是仅弹成功文案。 |
| 问答／审批 | 多题、单／多选、自填、拒绝、返回后重开 | 决定仍可见；不重复回答；宿主继续或停止的实际结果正确。 |
| 队列竞态 | 执行中追加两条，编辑一条、撤回一条、引导一次 | 修改没有被消费覆盖，撤回项未执行，引导进入预期运行。 |
| 断线／丢回执 | 上传中断、服务已收到但响应丢失、冷启动 | 草稿保留；重试不重传已收到的附件、不重复执行。 |
| 搜索与返回 | 搜索旧消息，打开命中、返回、再次进入 | 到达准确位置；消息上下文可读；查询及滚动位置符合预期。 |
| 主题与尺寸 | 日／夜，320dp，键盘，大字号，横屏 | 关键按钮不截断／遮挡，弹层可滚动，状态不只靠颜色。 |
| 声音与多媒体 | 朗读后切会话、退出、后台；取消拍照 | 音频生命周期明确；取消不清空草稿；未配置能力不伪装可用。 |
| 自维护闭环 | 真实模型读取知行代码、改一个明确问题、跑适用检查、产出可审查 diff／PR | 单独记录真实模型、检查回执、改动和审查结果；不能用固定测试回复替代。 |

## 8. RikkaHub 正式版之后的变化

对照 [3.1.1 到本次 master 快照][R-delta]，与本任务直接相关的变化包括：

- 加号主页面增加纵向滚动，避免矮屏把底部“压缩对话”等入口挤出屏幕。
- 折叠思考／工具时扩大可见范围，确保较早的待审批项不被隐藏。
- 消息和思考切换到新的选择容器，源码开始支持生成中选择文本；正式版 3.1.1 则在生成结束后才启用选择。
- 为正在生成的 Markdown 单独传递流式状态，继续改善未完成语法；编辑文件导出的 I/O 处理也有调整。

这些是开发分支源码变化，**未安装 master 构建验证**。它们说明成熟体验也需要持续处理滚动、选择、审批可见性等边缘状态；不宜把竞品某一版的所有细节都当作应照搬的规范。

## 9. 证据与复查入口

### 9.1 代表界面

代表截图及观察说明见 [截图对照](CHAT-EXPERIENCE-RIKKAHUB-SCREENSHOTS.md)。截图使用同一台 Android 16 ARM64 模拟器；主题、界面内容和系统语言不完全相同，因此用于核对结构与操作层级，不做像素级一致性评分。

RikkaHub 完整本机研究目录：`/Users/youmin/Developer/Codex/research/rikkahub-chat-20261029/`。包含官方 APK、源码快照、截图／XML、本地测试模型及选定源码差异。APK SHA-256：`9037a038620a6ca3ebcd69e8398930a948a48c2d1756fdef5af7b739016d7d26`。仅代表截图进入仓库，安装包、依赖、测试服务数据不提交。

知行完整本机验收目录与适用边界见 [DSH 验收记录](DSH-ACCEPTANCE-2026-10-29.md)。本轮只写文档，没有实施上述 P0／P1 功能，没有生产部署或正式发版。

### 9.2 源码依据

RikkaHub 链接固定到 3.1.1 提交，避免未来主分支变化导致本文错位。知行链接指向本仓库文件，本文的事实基线固定为第 1 节的提交。

| 证据组 | 关键文件 |
| --- | --- |
| RikkaHub 页面与输入 | [ChatPage][R-page]、[ChatList][R-list]、[ChatInput][R-input]、[ChatInputState][R-input-state] |
| RikkaHub 选择器 | [FilesPicker][R-plus]、[ModelList][R-model]、[ReasoningPicker][R-reasoning]、[SearchPicker][R-search]、[McpPicker][R-mcp]、[ExtensionSelector][R-extensions] |
| RikkaHub 消息动作 | [ChatMessage][R-message]、[ChatMessageActions][R-actions]、[ChatMessageCopySheet][R-copy]、[Translation][R-translation]、[ConversationExport][R-export] |
| RikkaHub 工具与数据语义 | [ChatMessageTools][R-tools]、[ToolUI][R-tool-registry]、[WorkspaceToolUIs][R-tool-renderers]、[EditedFiles][R-edited-files]、[ConversationMessages][R-versions]、[ChatService][R-service] |
| RikkaHub 多媒体与导航 | [ChatAttachmentPicker][R-attachment]、[ImagePreviewDialog][R-image]、[SketchDialog][R-sketch]、[ChatDrawer][R-drawer]、[ConversationList][R-conversation-list] |
| 知行入口与视图 | [AssistantApp][Z-app]、[DshChatPanel][Z-dsh]、[ReplyContent][Z-reply]、[dshProtocol][Z-protocol] |
| 知行共享交互 | [AgentChatHeader][Z-header]、[ConversationComposer][Z-composer]、[BottomSheet][Z-sheet]、[ModelPicker][Z-model]、[ReasoningPicker][Z-reasoning]、[PhotoAttachments][Z-photo]、[MessageBody][Z-body]、[AiDrawer][Z-drawer] |
| 知行宿主桥接 | [DSH 插件接口][Z-plugin]、[接入说明](../plugins/dsh-zhixing/README.md)；旧路径只作参照：[ChatPanel][Z-legacy] |

[R-release]: https://github.com/rikkahub/rikkahub/releases/tag/3.1.1
[R-page]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/pages/chat/ChatPage.kt
[R-list]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/pages/chat/ChatList.kt
[R-input]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/ChatInput.kt
[R-input-state]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/hooks/ChatInputState.kt
[R-plus]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/FilesPicker.kt
[R-model]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/ModelList.kt
[R-reasoning]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/ReasoningPicker.kt
[R-search]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/SearchPicker.kt
[R-mcp]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/McpPicker.kt
[R-extensions]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ui/ExtensionSelector.kt
[R-workspace]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/WorkspaceSelectSheet.kt
[R-cwd]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/WorkspaceCwdPicker.kt
[R-compress]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/CompressContextDialog.kt
[R-attachment]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/ChatAttachmentPicker.kt
[R-crop]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/ui/src/main/java/me/rerere/ui/crop/ImageCropDialog.kt
[R-image]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ui/ImagePreviewDialog.kt
[R-sketch]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/ui/src/main/java/me/rerere/ui/sketch/SketchDialog.kt
[R-sketch-text]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/ui/src/main/java/me/rerere/ui/sketch/SketchTextInput.kt
[R-message]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/ChatMessage.kt
[R-actions]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/ChatMessageActions.kt
[R-copy]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/ChatMessageCopySheet.kt
[R-translation]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/ChatMessageTranslation.kt
[R-usage]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/ChatMessageNerdLine.kt
[R-tts]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ui/TTSController.kt
[R-export]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/pages/chat/ConversationExport.kt
[R-markdown]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/richtext/Markdown.kt
[R-code]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/richtext/HighlightCodeBlock.kt
[R-voice]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/VoiceModeRow.kt
[R-edited-files]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/ChatMessageEditedFiles.kt
[R-tools]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/ChatMessageTools.kt
[R-tool-registry]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/tools/ToolUI.kt
[R-tool-renderers]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/message/tools/WorkspaceToolUIs.kt
[R-queue]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/MessageQueuePanel.kt
[R-error]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ui/ErrorCard.kt
[R-drawer]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/pages/chat/ChatDrawer.kt
[R-conversation-list]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/pages/chat/ConversationList.kt
[R-assistant]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/components/ai/AssistantPicker.kt
[R-system]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/ui/pages/chat/ConversationSystemPromptCard.kt
[R-versions]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/data/model/ConversationMessages.kt
[R-service]: https://github.com/rikkahub/rikkahub/blob/ad2c4430d50ba52392b2941367f98ef59614cb73/app/src/main/java/me/rerere/rikkahub/service/ChatService.kt
[R-delta]: https://github.com/rikkahub/rikkahub/compare/ad2c4430d50ba52392b2941367f98ef59614cb73...a5db9c9b770f316c76136970aa01a9d790e10e51
[Z-header]: ../src/AgentChatHeader.tsx
[Z-composer]: ../src/ConversationComposer.tsx
[Z-dsh]: ../src/DshChatPanel.tsx
[Z-body]: ../src/MessageBody.tsx
[Z-photo]: ../src/PhotoAttachments.tsx
[Z-drawer]: ../src/AiDrawer.tsx
[Z-app]: ../src/AssistantApp.tsx
[Z-reply]: ../src/ReplyContent.tsx
[Z-protocol]: ../src/dshProtocol.ts
[Z-plugin]: ../plugins/dsh-zhixing/server.mjs
[Z-sheet]: ../src/BottomSheet.tsx
[Z-model]: ../src/ModelPicker.tsx
[Z-reasoning]: ../src/ReasoningPicker.tsx
[Z-appearance]: ../src/AppearanceControl.tsx
[Z-legacy]: ../src/ChatPanel.tsx
