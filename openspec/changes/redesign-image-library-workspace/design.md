## Context

当前 Vistash 已经实现图片与提示词两个一级工作区、逻辑文件夹、标签、收藏、备注、回收站、多选、瀑布流、详情列表、检查器、全局搜索、布局记忆和 10,000 项虚拟化。它证明了 Rust 核心、SQLite 派生索引、Tauri IPC 和 React 行为契约可以工作，但前端仍带有验证性质：`App.tsx` 协调库状态、导入、工作区切换和全局定位，图片与提示词工作区各自超过 700 行，多个叶子模块直接依赖集中式 `shared/ipc.ts`，样式集中在一个全局文件中。

本变更不只是换皮。使用者确认了文件夹单一归属、目录层级导入、Windows 剪贴板导入、显示文件名、导出、默认程序打开和可停止长任务，这些决定会修改库格式、Rust 领域模型与 Tauri command。与此同时，提示词工作区必须保持可用，图像反推界面继续暂停。

设计服务于 Windows 优先、本地优先的单窗口桌面应用。素材库可能有数十 GB，但当前可度量界面规模仍为一次查询 10,000 条轻量记录；图片字节只按视口或显式预览读取。所有人类可读文案和注释使用简体中文，所有失败保持稳定错误码，不引入静默 fallback。

## Goals / Non-Goals

**Goals:**

- 建立图片优先、可长期使用的“高级媒体工作室”界面，并保持 Windows 原生窗口行为。
- 把图片管理收进单一公共入口的深模块，使应用外壳不再编排查询、选择、导入、检查器和缓存失效。
- 把旧版多文件夹素材安全迁移为零个或一个文件夹归属，不丢失使用者决策权。
- 为文件、目录、拖放、剪贴板导入和原图导出建立统一任务、进度、停止与错误语义。
- 保持提示词工作区的已批准行为，并通过导航与任务 seam 与图片模块协作而不共享内部 store。
- 先用可丢弃高保真原型确定品牌、布局和关键状态，再切换生产组件。
- 重构后继续通过 10,000 项虚拟化基线、键盘/可访问性检查和完整 Rust/前端门禁。

**Non-Goals:**

- 不实现图像反推、生图、provider 配置或提示词工作区视觉重构。
- 不实现智能文件夹、重复管理、评分、颜色旗标、EXIF 检索、相似搜索、AI 标签或图片编辑。
- 不实现文件系统监控、云同步、账号、原生拖出、批量重命名或通用素材操作撤销历史。
- 不把图片集合改成分页或无限查询；真实规模证明 10,000 项全量轻量元数据成为瓶颈前不增加协议。
- 不自绘 Windows 标题栏，不引入完整 Fluent UI、Tailwind、shadcn/ui、Redux、Zustand 或 React Router。
- 不建立图片与提示词共用的 `GenericCatalog<T>`、`Workspace<T>` 或为未来反推预留的空 port。

## Decisions

### 1. 先原型、后生产切换

在实现生产工作区前，使用固定假数据制作独立高保真原型，至少覆盖欢迎页、空库、瀑布流、详情列表、单选检查器、多选操作栏、灯箱、搜索、任务中心、设置以及深浅主题关键状态。原型不调用 Tauri IPC、不修改真实库，也不默认成为生产依赖。

原型通过评审后，把最终品牌资产、token、布局、断点和交互状态补回本设计与任务，再以纵向切片实现生产模块。旧界面只在开发分支中作为行为参照；新工作区达到功能、测试和性能等价后一次切换入口，并删除旧组件、旧全局样式和被新 interface 取代的浅层测试。正式构建不保留 legacy 开关。

备选方案是直接在当前组件上精修。该方案会让视觉试验与库格式、状态架构同时发生，难以判断回归来自设计还是行为，因此拒绝。

#### 原型评审结论：选择 A — Archive Desk

2026-08-25 的第一轮主工作区评审在三套可切换高保真方案中选择 A — Archive Desk 作为唯一生产设计基线。生产界面 MUST（必须）保留以下方向：

- 原生 Windows 标题栏下方使用紧凑应用顶栏，不改变系统窗口行为。
- 宽屏使用稳定的“左侧档案导航—中央图片墙—右侧纵向检查器”三栏结构，图片墙获得主要面积。
- 采用深石墨表面、精细单像素分隔、单一暖珊瑚强调和克制阴影；图片本身承担主要色彩。
- 瀑布流卡片默认弱化文字，悬停或选中时才增强显示文件名与尺寸；选中边界必须清晰且不遮挡图片。
- 文件夹、筛选、排序、密度、视图切换、任务和批量操作保持可见且紧凑，不把核心能力藏进多层菜单。
- 检查器保持连续纵向分区，图片摘要、色卡、组织和备注形成从视觉到管理的自然顺序。

B — Darkroom Strip 不作为主工作区，因为底部信息台和极大联系表会压缩文件夹、批量组织与持续检查器；C — Curator Ledger 不作为主工作区，因为编辑画册式构图降低大规模素材整理密度。两者只保留为评审证据，不批准其组件、布局或代码直接进入生产。

本轮批准的是视觉方向与信息层级，不是原型实现。`app/src/prototypes/image-library` 仍为 throwaway implementation；生产模块必须按本设计的深模块 interface、错误语义、测试和可访问性要求重新实现。欢迎页、空库、设置、浅色主题和窄窗口将在 A 的语言下补齐后完成第二轮评审。

2026-08-25 的第二轮评审确认 A 的欢迎页、空素材库、设置 Dialog、同结构浅色主题与窄窗口方案全部沿用。欢迎页使用“本地视觉档案”叙事与明确的本地库承诺；空库在保留工作台结构的同时把导入、文件夹导入和粘贴作为唯一主引导；设置保持有限范围；浅色主题只替换语义 token，不改变信息架构。第二轮仍未批准 prototype implementation 直接复用，最终应用图标、字体文件和图标包继续由任务 1.4 单独冻结。

#### 原型最终验收基线

原型评审证据保存在 `app/artifacts/prototype-image-library/`，覆盖 A/B/C 主工作区以及 A 的欢迎、空库、设置、浅色、多选、品牌与 760×760 窄窗口截图。自动检查同时验证详情列表切换、灯箱 `Esc` 返回、关键文字对比度、Tab 焦点、减少动态效果和无水平溢出。

生产实现冻结以下视觉与可访问性基线：

- 1440×900 是宽屏主参考；宽度大于 1050 px 时保持三栏，781—1050 px 时左栏收为图标导航，780 px 及以下时右检查器通过覆盖抽屉进入，中央区不得水平滚动。
- 常规 UI 文本不得小于 12 px，次级元数据不得小于 11 px；10 px 仅限不承载操作含义的装饰性英文 eyebrow。prototype 中为截图密度使用的 6—9 px 字号不得直接复制进生产。
- 普通文本、导航、主按钮和选中状态的目标对比度至少 4.5:1；Tab 焦点使用至少 2 px 的高可见轮廓，不得只靠颜色变化。
- hover/选中反馈使用 160—220 ms；栏位与 Dialog 状态变化不超过 240 ms。`prefers-reduced-motion: reduce` 下非必要动画与过渡时长降至近零，任务进度仍保留非位移状态变化。
- 多选时瀑布流、底部上下文操作栏和右侧批量检查器必须同时反映同一选择集合；文件夹动作始终写“移动”，不得恢复为多归属“加入”。
- prototype implementation、远程 Picsum 假图、状态切换器、B/C 方案和生成联系表全部拒绝进入生产 bundle；批准的只有信息层级、标识几何、token 和交互结论。

重构后的 10,000 项性能门禁固定为：瀑布流首屏不超过 350 ms，初始集合 DOM 不超过 24、快速滚动峰值不超过 40，快速滚动平均双帧不超过 20 ms、最坏不超过 35 ms，稳定 heap 不超过 60 MiB、视图切换后不超过 65 MiB，瀑布流/详情列表切换不超过 50 ms。任何超门禁项必须先诊断，不能靠增大阈值完成任务。

### 2. 三个纵向深模块与唯一公共出口

前端建立 `library-lifecycle`、`asset-library`、`prompt-library` 三个纵向模块。每个模块只允许从 `index.ts` 导入，`internal/` 是 implementation，不属于其他模块可依赖的 interface。

图片模块的公开 interface 保持窄小：

```ts
export type OpenLibrarySession = {
  id: LibraryId;
  displayName: string;
};

export type AssetLibraryEntry =
  | { kind: "resume" }
  | {
      kind: "locate";
      requestId: string;
      assetId: AssetId;
      location: "active" | "trash";
    };

export type AssetLibraryWorkspaceProps = {
  session: OpenLibrarySession;
  active: boolean;
  entry?: AssetLibraryEntry;
};

export function AssetLibraryWorkspace(
  props: AssetLibraryWorkspaceProps,
): React.ReactElement;
```

`library-lifecycle` 负责欢迎、开库、损坏/版本失败、迁移计划、冲突处理和切库，只有完成兼容性门禁后才产生 `OpenLibrarySession`。图片模块内部拥有查询、选择、文件夹、标签、检查器、灯箱、导入导出、布局偏好、TanStack Query key、虚拟化和图片 URL 生命周期。

备选方案一是顶层平铺 `import/`、`export/`、`folders/`、`selection/` 等 feature；删除任何一个后编排复杂度都会回到 `App.tsx`，属于浅模块，因此拒绝。备选方案二是公开无头 `AssetLibrarySession` 的完整 Snapshot/Intent/Command；当前没有第二种宿主，这会为假想 seam 冻结巨型 interface，因此拒绝。

### 3. 导航、任务中心、全局搜索与平台 adapter 是应用级 seam

图片和提示词都真实需要跨工作区定位、长任务摘要和全局搜索，因此 `WorkspaceNavigation`、`TaskCenter`、`GlobalSearch` 是应用层拥有的窄 interface。它们必须使用判别联合或明确方法，禁止演化为无类型全局 Event Bus。

Tauri 是项目自有的跨进程依赖。生产使用 `TauriPlatformAdapter`，测试使用 `MemoryPlatformAdapter`，因此这是具有两个 adapter 的真实 seam。adapter 负责 command/channel/event/对话框/剪贴板/默认程序与媒体租约的传输映射；产品规则、自动重试、缓存失效和默认值不进入 adapter。

图片与提示词的普通关联继续通过后端用例完成。两个 UI 模块不得互相导入内部组件、query key 或 store；关联变更通过权威写入结果与模块级失效事件协调。

### 4. TanStack Query 只管理异步 IPC 状态

使用 TanStack Query 管理库状态、集合快照、详情、全局搜索和 mutation。QueryClient 在应用组合根创建，图片模块隐藏自己的 key 工厂与失效规则。key 必须包含 `libraryId`，默认 `retry` 为 `false`，关闭窗口聚焦和网络重连触发的无条件全库刷新，并给历史筛选查询设置有限 `gcTime`。

选择、活动项、框选锚点、灯箱、面板和输入草稿使用 React state、reducer 与模块内部 Context。布局偏好继续通过后端持久化。mutation 成功后由图片模块精确失效集合、详情、计数或关联查询；删除 `catalogVersion`/`refreshVersion` 这类穿透外壳的刷新协议。

备选方案是 Redux/Zustand 统一管理全部状态，它会混合权威异步数据与短生命周期 UI 状态，且当前不存在需要第二个 store adapter 的 seam，因此拒绝。

### 5. Radix Primitives、内部 UI 模块与 CSS Modules

复杂可访问交互选择 Radix Primitives，按实际需要安装 Dialog、AlertDialog、Popover、DropdownMenu、ContextMenu、Tooltip、Select 与 ScrollArea 等包。Vistash 自己实现 Button、IconButton、SearchField、Toolbar、Panel、EmptyState、Progress、Toast 等无业务 UI 模块；`AssetCard`、`FolderTree`、`AssetInspector` 和 `SelectionBar` 留在图片模块内部。

样式使用全局 `reset.css`、`tokens.css`、`globals.css` 与模块级 `.module.css`。token 表达表面、文本、边界、强调、选中、焦点、状态、间距、圆角、阴影、动效、层级和字体，业务规则禁止散落具体主题色。图标只选择一套；具体字体、强调色和图标包在高保真原型评审后冻结。

完整 Fluent UI 虽能提供 Windows 熟悉度，但会显著限制 Vistash 的品牌差异；Tailwind/shadcn 会引入新的样式与生成约定，而当前需要可审查的长期组件 interface，因此均不采用。

### 6. 原生标题栏、直接恢复与响应式三栏

保留 Windows 原生标题栏。应用内顶栏只承载紧凑品牌、一级入口、全局搜索、导入、任务和设置。已有可用库时直接恢复上次工作现场，不增加首页；首次运行和库失败由 `library-lifecycle` 接管。

宽屏保持左分类、中央集合、右检查器三栏；中等宽度把左栏变为按需导航，窄宽度把右栏变为覆盖抽屉，中央区始终优先。图片与提示词分别持久化栏宽、折叠、查询、排序、视图和滚动；图片额外保存缩略图尺寸与检查器分区状态。具体断点由原型在目标窗口尺寸上验证后写入 token，不成为业务组件中的魔法值。

### 7. 深浅主题和轻量品牌系统

主题提供 `system`、`dark`、`light` 三值偏好，默认 `system`，监听 Windows 主题变化。深色石墨主题是主视觉，浅色使用温和中性表面；二者共用 DOM、组件状态和语义 token。系统减少动态效果时取消非必要位移、缩放和视差，仅保留即时状态过渡。

品牌阶段重做应用图标、紧凑字标、一种强调色和 UI/展示字体组合。参考分工为 Eagle 的素材密度、Lightroom 的暗色图片工作台、Linear 的交互精度、Are.na 的档案气质和 Windows 的窗口/键盘习惯，不复制任何单一产品，也不采用营销页 Hero、滚动叙事、玻璃发光或满屏胶囊。

#### 品牌评审结论

2026-08-25 品牌板评审确认以下基础：

- 应用标识使用“叠放档案框＋负形 V”。两层框体表达本地档案，实心 V 同时指向 Vistash 与观看视野；禁止回到通用山峰、太阳、镜头光圈或图片占位符。
- 主色固定为 Archive Black `#111313`、Graphite `#171919`、Bone `#ebe7dd` 与 Signal Coral `#e8664a`。Status Green `#6e9b73` 只表示成功或健康状态，不作为第二品牌强调色。
- Windows UI 字体栈使用 `Bahnschrift, "Microsoft YaHei UI", sans-serif`。Bahnschrift 负责拉丁字符、数字和紧凑技术气质，Microsoft YaHei UI 负责简体中文小尺寸界面；不随应用重新分发 Microsoft 字体文件。
- 展示字体栈使用 `Georgia, SimSun, serif`，只用于欢迎页、集合标题和少量品牌语句，MUST NOT（禁止）进入表格、表单、标签和用户长文本。
- 唯一通用图标系统使用 `@phosphor-icons/react`，默认 `regular` weight，活动收藏等填充状态使用 `fill`。从具体 CSR 文件路径导入实际使用图标，MUST NOT（禁止）整包命名空间导入或混用 Lucide、Radix Icons、Unicode 符号和 Emoji。
- 原型 SVG `app/src/prototypes/image-library/assets/vistash-icon-concept.svg` 是品牌几何的评审证据。生产任务必须从批准几何生成无 BOM SVG 源、Tauri PNG/ICO 全尺寸资源并逐个检查 16、32、64、128、256 与 512/1024 px；不得直接把 prototype 路径变成生产依赖。

选择 Windows 内置 UI 字体而不是打包完整 CJK Web Font 是有意的：素材名称、标签和备注可能包含任意中文，完整覆盖字体会显著增加安装包；Windows 官方把 Microsoft YaHei UI 定义为简体中文界面字体，而产品的独特性由展示字体、间距、图片主导结构、标识和颜色共同承担。

### 8. 素材侧车升级为单归属与显式来源

新库格式把旧版 `original_filename` 与多值文件夹字段迁移为显式结构。概念形状如下，最终 Rust 类型名称可按现有领域命名调整：

```rust
enum AssetSource {
    Filesystem {
        path: Option<PathBuf>,
        filename: String,
    },
    Clipboard {
        captured_at: DateTime<Utc>,
        filename: String,
    },
}

struct AssetMetadata {
    source: AssetSource,
    display_filename: String,
    folder: Option<LogicalFolderPath>,
    // 其余既有权威字段保持显式。
}
```

文件系统导入把来源路径与来源文件名写入 `Filesystem`；v2 允许来源路径缺失，迁移时必须保留为显式 `path: null`，MUST NOT（禁止）伪造路径或用默认字符串顶替。位图粘贴生成带本地时间的 PNG 名称，同时记录 UTC 捕获时间。显示文件名是必填字段，不使用读取时 fallback；迁移明确把旧原始文件名复制到来源与显示字段。扩展名由真实媒体格式拥有，重命名只修改名称主体。

单归属文件夹把“移动”变成唯一写操作，目标为 `None` 时表示未分类。标签继续多值。旧版多归属数据不能靠取第一项解决。

### 9. 迁移使用计划、暂存、提交和恢复日志

旧库打开后先只读扫描侧车并生成迁移计划。无冲突项自动得到确定映射，多归属项必须完成唯一目标选择。确认前不写任何权威文件。

提交时在库内创建带唯一 ID 的迁移工作目录，只暂存库级元数据、文件夹树、侧车与恢复日志，不复制素材本体。流程为：

1. 校验计划仍对应当前库版本与侧车摘要。
2. 写完全部新侧车与新库级元数据到暂存区。
3. 写恢复日志并把旧权威元数据备份到同卷迁移目录。
4. 逐项原子替换权威元数据。
5. 删除并从新元数据重建 SQLite 派生索引。
6. 校验不变量后更新迁移日志为完成，再清理备份。

任一步失败都按恢复日志把旧元数据放回并保留旧格式版本。进程在提交期间异常退出时，下次开库必须先检测未完成日志并执行恢复，不能猜测当前文件属于新旧哪一代。迁移进入替换阶段后不提供取消；冲突选择与确认前可以退出。

### 10. 四种入站来源汇入同一 Rust 导入协调器

文件选择、目录选择、拖放与剪贴板只负责产生 `ImportSource`，之后进入同一 Rust 协调器。文件导入到当前具体逻辑文件夹；当前是全部、未分类或回收站时进入未分类。文件夹导入以当前具体文件夹为父级，否则从逻辑根开始，并保留所选目录名与相对层级。

路径规范化在写入前完成；同逻辑路径合并。目录中的非图片计入跳过结果。重复内容不复制，也不移动既有素材。扫描、哈希、复制、解码、缩略图、色卡、侧车和索引继续在窗口线程之外执行。

每个长任务拥有 `TaskId` 和库级 `concurrencyKey`。停止通过真实后端命令设置取消状态；扫描阶段尽快观察，处理阶段在单素材事务边界观察。已成功素材保留，当前素材成功或回滚，后续项记为未处理。

### 11. Windows 剪贴板全部留在 Rust/platform seam

资源管理器复制的文件列表通过 Windows `CF_HDROP` 读取完整路径；生产 adapter 使用 Microsoft `windows` crate 的 `OpenClipboard`、`GetClipboardData`、`DragQueryFileW` 与 RAII `CloseClipboard` guard，并只启用 `Win32_Foundation`、`Win32_System_DataExchange`、`Win32_System_Ole`、`Win32_UI_Shell` 和 `Win32_Storage_FileSystem` 等实际所需 features。打开剪贴板失败必须返回稳定的 `clipboard.busy`，不得冒充空剪贴板。句柄内容在 `CloseClipboard` 前立即复制成自有 `PathBuf`，目录扫描和解码只能在关闭剪贴板后开始。

第一阶段只支持具有真实文件系统路径的 `CF_HDROP`，明确排除依赖 `CFSTR_FILEDESCRIPTOR`/`CFSTR_FILECONTENTS` 的 Shell 虚拟文件。即使剪贴板来自“剪切”，Vistash 也只复制进库，绝不执行源文件移动或删除。

截图或应用复制的位图由 Rust blocking worker 调用官方 `tauri-plugin-clipboard-manager` 的 Rust `ClipboardExt::read_image()`，检查尺寸与 `width * height * 4` 上限后在 Rust 侧编码 PNG，并直接进入现有哈希与导入管线。前端只提交“从剪贴板导入”意图，不接收 RGBA、`ImageData` 或其他像素缓冲。文件列表优先于位图，纯文本和网址不处理。WebView 不获得通用 `clipboard-manager:allow-read-image` 权限，只获得 Vistash 领域 command。

窗口级 `Ctrl+V` 只在图片模块 `active` 且事件目标不属于可编辑控件时认领。文本框、搜索框和备注编辑器保持原生粘贴。文件/目录选择继续使用官方 `tauri-plugin-dialog`，但由窄 Rust command 直接接收结果并开始导入，避免把任意选择路径扩大成 WebView 文件读取 scope。

一手资料与本机最小验证记录在 `research/windows-platform-integration.md` 和 `app/scripts/prototype-windows-platform-check.ps1`。验证在不修改系统剪贴板的情况下构造 `DROPFILES` 内存并由 `DragQueryFileW` 往返两条 Unicode 路径，同时验证只读删除拒绝、占用删除拒绝与位图 PNG 编码。

### 12. 导出、复制图像与默认程序打开不暴露哈希库布局

导出由 Rust 读取权威索引确定本体路径，并用显示文件名与真实扩展名复制到使用者选择的目录。同名冲突先生成冲突计划，使用者明确选择跳过、覆盖或自动编号后才写入。覆盖必须二次确认；报告逐项隔离失败，并支持在单文件边界停止。

“复制图像”只允许单张图片，由 Rust 解码并写入 Windows 位图剪贴板。多选不合成图片。

“使用默认程序打开”不直接把内容哈希对象交给可能写回的外部程序。Rust command 在 `app_cache_dir()/external-open/v1/<session-id>/` 创建使用显示文件名和真实扩展名的只读副本，写入只含相对文件名、素材 ID、创建时间与版本的 manifest，再通过官方 `tauri-plugin-opener` Rust `OpenerExt` 调用 Windows 默认关联程序。WebView 不获得素材库或任意磁盘路径的 `openPath` scope；外部修改只影响副本。界面不提供“在资源管理器中显示”内部哈希对象。

`openPath` 返回不代表外部程序已经释放文件，且 Shell 可能复用既有进程而不给出可等待的进程句柄，因此禁止立即删除副本。当前 session 运行期间不清理自身目录；应用启动时只处理非当前 session、具有有效 manifest 且创建超过 24 小时的目录。清理前移除 Vistash 设置的只读属性；`ERROR_SHARING_VIOLATION` 表示外部仍占用，必须保留并在下次启动重试；其他错误显式记录。清理前必须解析绝对路径并证明目标仍位于 `app_cache_dir()/external-open/v1/`，不得沿 junction、符号链接、reparse point 或 manifest 外路径递归删除。

### 13. 任务中心只聚合，不拥有业务事务

`TaskCenter` 记录任务 ID、种类、库作用域、并发键、状态、节流进度和完成报告。图片模块拥有导入、导出和批量操作的业务协调；任务中心不能决定回滚、重试或缓存失效。关闭任务详情不停止任务，切换一级工作区不卸载任务状态。

状态至少区分 `running`、`stopping`、`stopped`、`succeeded`、`partial`、`failed`。只有后端确认后进入 `stopped`。成功且无需处理的记录可在查看后移除；部分成功、停止或失败保留到使用者明确关闭。

反馈分层为字段附近的就地错误、短暂成功 Toast、稳定任务报告和不可逆操作 Dialog。未知协议或不变量错误继续抛给应用级错误边界，禁止 catch-log-rethrow 或通用“操作失败”兜底。

### 14. 集合保持全量轻量记录与真正虚拟化

本变更继续使用一次查询返回当前结果全部轻量行的 IPC。TanStack Query 只有限缓存历史筛选；缩略图、原图、详情、色卡和关联数据按需读取。瀑布流和详情列表继续使用 `@tanstack/react-virtual`，仅为视口与过扫窗口创建 DOM。

媒体接口返回显式租约：

```ts
export type ImageLease = {
  url: string;
  release(): void;
};
```

租约隐藏 Blob URL 或未来 asset protocol 的差异，并由图片模块在项卸载、换源、预览关闭、LRU 淘汰和切库时释放。重构后的 10,000 项基线不得明显劣于当前约 295 ms 瀑布流首屏、12 个初始项 DOM、22 个峰值项 DOM、47.5 MiB heap 和 37 ms 视图切换；具体允许回归阈值在原型冻结布局后写入任务验收数据。

分页只在真实 50,000/100,000 规模测量证明元数据传输、排序或内存成为瓶颈后另立变更。图片模块 interface 不暴露当前是否分页。

### 15. 选择、检查器和灯箱共享一个模块内 session

选择集合只保存素材 ID，活动项必须属于选择集合。瀑布流和详情列表共享查询、排序、选择、活动项和滚动恢复。多选采用 Windows 习惯：单击、`Ctrl+单击`、`Shift+单击`、`Ctrl+A`、框选与 `Esc`；底部上下文操作栏提供移动、标签、收藏、关联和回收站操作，右键菜单只作快捷入口。

检查器使用纵向可折叠分区而非互斥 Tab。灯箱覆盖当前窗口，按当前查询顺序导航相邻素材，缩放和平移只用标准图像渲染与 CSS transform，不读取像素。退出后恢复原滚动位置并把最后查看素材设为活动项。

### 16. 测试通过模块 interface 与真实平台验收

生产 Tauri adapter 和内存 adapter 必须满足同一领域 port contract。图片工作区行为测试从 `asset-library/index.ts` 的公开 interface 渲染，验证查询、选择、导入意图、批量结果、迁移闸口和任务反馈；不在每个叶子组件 mock 数十个 `invoke` 函数。纯瀑布流几何、选择算法和迁移计划可保留模块内部 seam 的确定性测试，但调用者测试不得穿透内部目录。

Rust 测试覆盖新侧车序列化、旧库迁移、恢复日志、单归属事务、显示文件名、目录层级合并、停止边界、导出冲突与逐项失败。Windows 层必须手工或自动验收资源管理器文件粘贴、截图位图粘贴、文本控件粘贴、文件/目录对话框、默认程序打开、原生标题栏和拖放。

前端 lint、类型检查、Vitest、Rust Clippy 与 Rust test 按仓库规则串行运行；前端和 Rust 全量门禁禁止并行争抢 CPU。高保真原型通过截图与交互检查，生产界面再使用 `webapp-testing` 和 `web-design-guidelines` 验证。

### 17. 正式前端启动前冻结后端 IPC

2026-08-26 的两轴审查发现：后端核心测试虽全部通过，但 v2→v3 开库分派、`import_stop` managed-state 精确类型、显示文件名修改 IPC、导出冲突规划 IPC、任务 ID 跨 IPC 与 external-open 错误语义仍有接线缺口。任务 6.5—6.13 作为正式前端之前的接口冻结门禁：7.1—7.4 只在这些修复全部转绿后开始，避免生产前端围绕错误 DTO 或不可调用命令返工。

修复必须从真实公开 seam 验证：库格式探测必须把 v2 导向 v3 计划；Tauri State 使用同一公开 managed type；显示名与导出规划同时具备 Rust command、注册、TypeScript DTO 与 IPC wrapper；长任务 ID 必须出现在启动/进度/结果/停止全链路；external-open 只允许 `NotFound` 清单表示空，解析、权限和回写失败不得静默降级。

## Risks / Trade-offs

- [Risk] 单归属文件夹会改变既有库语义，错误迁移会永久丢失组织信息 → 迁移先只读规划，多归属必须人工选择，使用同卷暂存、恢复日志和整体回滚，提交前不修改原库。
- [Risk] 新 change 同时包含视觉重构与后端新增能力，范围较大 → 任务按库格式、platform seam、应用基础、图片纵向切片和最终切换排序，每个任务完成测试后立即勾选，原型先冻结视觉变量。
- [Risk] 深模块内部可能再次长成难以导航的巨型文件 → 唯一公共出口保持窄小，内部按 session、collection、organization、transfer、media 等真实知识簇组织，并通过公开 interface 做主要行为测试。
- [Risk] `TaskCenter` 或导航演化成无类型事件总线 → 只接受明确判别联合与固定作用域，不允许任意字符串主题或业务 payload。
- [Risk] TanStack Query 缓存多个 10,000 项结果增加内存 → key 包含库身份，历史查询使用有限 `gcTime`，媒体字节不进入集合 cache，并复测 heap。
- [Risk] Windows 剪贴板、默认程序和文件对话框无法仅靠浏览器测试覆盖 → platform adapter 隔离，内存 adapter 做确定性测试，release Tauri 构建执行 Windows 层验收。
- [Risk] 默认程序可能改写库内哈希对象 → 只打开应用管理的只读临时副本，不把权威本体路径交给外部程序。
- [Risk] 导入停止响应过慢 → 扫描循环与每个素材事务边界观察取消状态，任务中心在后端确认前显示“正在停止”。
- [Risk] 原型代码被无审查复制进生产并形成第二套架构 → 原型与生产目录、依赖和数据源隔离，评审只批准设计决策；复用任何代码必须由对应实施任务明确批准。
- [Trade-off] 保留全量轻量记录避免当前没有证据的分页复杂度，但不面向 100,000 项承诺 → 维持 10,000 项门禁，并让模块 interface 隐藏查询实现以便未来替换。
- [Trade-off] 暂不提供通用撤销，误操作恢复不如专业 DAM 完整 → 永久删除二次确认，回收站可还原，组织操作反馈明确；可靠撤销历史另立规格。

## Migration Plan

1. 完成并严格校验本 change；在修改生产行为前冻结 delta specs、迁移不变量与适配器 interface。
2. 制作独立高保真原型，评审并把最终品牌 token、断点、关键布局和性能阈值补入设计与任务。
3. 先在 Rust 建立新库格式、显式来源/显示文件名、单归属 folder、只读迁移计划和恢复日志；用 fixture 验证无冲突、多冲突、写入失败和进程中断恢复。
4. v3 侧车字段与单归属操作先只通过其公开 interface 验证；在迁移提交、恢复日志和打开门禁完成前，生产 `AssetSidecar` 别名、Catalog、SQLite 索引与批量命令继续使用 v2，禁止形成“新阅读器已启用但旧库无法迁移”的中间状态。
5. 迁移门禁完成后，用迁移后的 v3 fixture 验证索引重建、双文件名查询与 Catalog 单归属事务，再一次切换生产别名、SQLite、Catalog 和批量命令。
6. 建立 platform ports、Tauri/Memory adapters 与任务中心，不切换现有生产工作区。
7. 实现目录/剪贴板导入、停止、导出、复制图像和默认程序临时副本，并完成 Windows 验收。
8. 建立 UI token、Radix 基础模块、应用外壳和 `library-lifecycle`；随后按集合、组织、检查器、灯箱、传输和任务状态完成 `asset-library` 纵向切片。
9. 用新模块公开 interface 重建行为测试，验证提示词入口和关联行为未回归；复测 10,000 项性能与深浅主题/键盘/窄窗口。
10. 达到功能与门禁等价后切换 `App.tsx` 到新模块，删除旧图片工作区、旧浅层刷新协议和被替代样式；不保留运行时 legacy 开关。
11. 运行全部四类项目门禁、Windows release 验收、OpenSpec strict validate 与最终 code review。

若生产切换前失败，可继续使用旧界面和旧格式 fixture；一旦真实库成功迁移到新格式，不提供应用内降级写回。迁移事务本身失败时按恢复日志回到旧格式，应用二进制回滚必须使用仍支持旧格式的版本。

## Open Questions

当前没有阻断实施的开放问题。依赖的精确版本由任务 7.1 在安装时锁定；视觉、断点、动效、可访问性与性能验收值已经由原型评审冻结。
