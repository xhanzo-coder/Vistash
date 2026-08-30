# 提示词工作台现状基线与首轮校正

日期：2026-08-29

## Hallmark 审查

旧页面的主要问题不是单个颜色或间距，而是提示词工作区仍在使用另一套界面语法：

- **Critical — 宏观结构漂移**：图片页已经是 Archive Desk Workbench，提示词页仍由 `catalog-rail`、分散查询行和旧检查器外壳拼成，两个一级工作区不像同一产品。
- **Critical — 操作层级错误**：折叠分类栏、折叠检查器、卡片瀑布流和详情列表均以同权重文字按钮常驻，领域操作与视图状态没有层级差异。
- **Major — 左栏错误占位**：文件夹新建表单固定在栏底，回收站与图片页的底部归档入口不同构，空文件夹时仍占据大块表单区域。
- **Major — 装饰文字过量**：`PROMPTS`、`PROMPT LIBRARY`、`INSPECTOR`、`NO PROMPTS`、`MULTI SELECT` 等 eyebrow 重复表达邻近中文标题，没有新增信息。
- **Major — 空状态承诺不真实**：旧文案声称可“从检查器新建”手写记录，但空检查器并没有对应入口。

用户提供的旧状态截图：

- `codex-clipboard-952ae0dd-5bb9-4f04-ba9f-aafde8b7531e.png`：标出了文字折叠按钮、底部新建表单、回收站和文字视图切换的结构差异。
- `codex-clipboard-b5ad6691-7963-479a-b7a5-75c9f3fae450.png`：记录了整页旧视觉、装饰英文标签和虚线空状态。

## 必须保留的行为

- 提示词查询：正文/标题搜索、文件夹、标签、收藏和正常区/回收站位置。
- 卡片与详情列表共享排序、选择、活动项和查询状态。
- 单击只更新检查器；双击或 Enter 显式进入聚焦阅读/编辑。
- 提示词文件夹增删改、回收站还原/清空、批量组织和逐项错误语义。
- 提示词独立的栏宽、折叠、视图和滚动偏好；不得继承图片页业务状态。

## 必须删除或替换的呈现

- 删除所有仅作装饰的英文 eyebrow 和大块虚线空状态。
- 文字折叠按钮替换为与图片页一致的 `SidebarSimpleIcon` 纯图标按钮、Tooltip 和可访问名称。
- 宽屏折叠后保留 3.5rem 图标窄栏，不把展开按钮塞进中央查询栏。
- 文件夹操作收进“文件夹”标题旁的图标组；创建与重命名使用 Dialog，不再固定占用左栏底部。
- 回收站固定在左栏底部，并与图片页使用同样的图标入口和数量徽章。
- 卡片/列表切换使用与图片页同源的图标切换组；中央查询栏只保留查询、排序、密度和视图。

## 旧全局样式所有权

首轮已把工作台骨架、左导航、查询栏、空状态和右栏外壳迁入 `PromptWorkspace.module.css`。`styles.css` 仍拥有以下后续切片需要迁移的生产规则：

- `prompt-waterfall`、`prompt-card-*`：任务 3.1–3.2 的卡片视觉和虚拟布局。
- `prompt-detail-list`、`prompt-title-*`：任务 3.3–3.4 的详情列表。
- `prompt-body-focus`、`prompt-edit-*`、`prompt-image-links`：任务 4.1–4.4 的检查器与聚焦编辑。
- `prompt-workspace` 的三栏 grid 与共享 separator：任务 6.1–6.2 完成模块化后迁出。
- `catalog-rail`、`query-bar`、`tag-filter`、旧 `empty-state` 和 `rail-toggle`：新工作台已不再引用，待任务 7.1 做零引用证明后删除，不保留兼容分支。

## 真实 Tauri 校正结果

真实 Windows Tauri 进程经过全新启动后验证，截图位于：

- 真实 Tauri 空提示词页已人工核对；为避免当前用户库名称进入版本库，不保留实机截图。

已人工操作并核对：

- 展开状态下，提示词页与图片页具有相同的三栏宽度节奏、标题行、单行查询栏和图标视图切换。
- 左导航折叠后保留“全部/收藏/根位置/回收站”四个图标，文件夹、标签和数量徽章隐藏，无水平滚动。
- 右检查器折叠后保留 3.5rem 图标窄栏；再次点击同一位置恢复检查器。
- 空库文案为真实状态，不再出现虚假“从检查器新建”入口。

截图中的蓝色鼠标光晕来自 Windows 自动化验收工具的指针高亮，不属于应用界面。

## 首轮自动检查

- `pnpm typecheck`：通过。
- `pnpm vitest run src/modules/prompt-library/internal/PromptWorkspace.test.tsx`：33/33 通过。
- `pnpm vitest run src/modules/prompt-library/internal/PromptWorkspace.test.tsx src/modules/asset-library/AssetLibraryWorkspace.test.tsx`：121/121 通过；共享栏位改动未破坏图片页。

## 2026-08-30：范围胶囊、文件夹一致性与手动新增

用户截图中的“只看收藏 ×”不是标签数据，而是共享查询控制器把左栏收藏状态再次渲染成 `AppliedFilterChips`。同一截图中收藏与提示词根位置同时高亮，证明根因是提示词仍把收藏当可叠加筛选轴。现已把全部、收藏、提示词根位置、具体文件夹和回收站改为互斥范围：入口原子清除旧文本、标签、收藏和位置；删除零消费者的 `AppliedFilterChips` 组件及全局样式，中央区不再新增一行重复状态。

提示词文件夹不再使用标题旁常驻的新增/重命名/删除三按钮。标题旁只保留新建入口，新建在当前树节点下即时输入；具体节点右键提供新建子文件夹、重命名、嵌套节点移到顶层、移动文件夹和删除。文件夹缩进、Folder/FolderOpen 图标、竖向层级引导、指针拖动预览和移动 Dialog 与图片侧使用同一共享 `useFolderTreeDrag` 协议。

核心新增 `move_prompt_folder` 深命令并注册 Tauri/TypeScript IPC。重命名和移动共用 `relocate_prompt_folder` 事务：完整子树、提示词文件夹清单和每条受影响的多文件夹成员关系一次提交；自身/后代目标显式拒绝，其他文件夹归属保持不变。两条 Rust 红—绿测试锁定了子树重映射和非法后代不改现场。

手动新增提示词采用中央聚焦创作面板。标题区和真实空状态共享“新建提示词”入口；正文唯一必填，标题、模型/平台、参数可选。具体文件夹范围自动成为初始归属，收藏等范围从根位置创建；`Ctrl+S` 和主按钮共用写入，失败保留草稿，成功后清理隐藏条件并聚焦新提示词。1280×800 实机复查后把编辑器改为固定头尾与自适应正文，保存按钮无需滚动即可到达。

验证结果：

- `pnpm lint`、`pnpm typecheck`、46 个 Vitest 文件 407 项与 17 个 Node 用例全部通过。
- `cargo clippy --workspace --all-targets -- -D warnings` 通过。
- `cargo test --workspace` 通过：核心测试由 302 增至 304，全部 Tauri、剪贴板、导入、迁移、侧车与文档测试通过。
- 真实 Tauri WebView2 人工确认重复胶囊为 0、范围单选、右键菜单完整、根位置树内命名、新建编辑器可见、保存按钮可达且根页面 `scrollWidth == clientWidth == 1280`。一次性实机脚本与截图不入库；可重复自动化证据使用公开工作区测试和匿名 fixture。
- `cargo fmt --all --check` 会要求重排仓库内大量既有 Rust 文件，差异不局限于本轮文件；为避免批量覆盖用户当前未提交代码未执行全局格式写入，本轮新增 Rust 代码由 Clippy 与编译门禁验证。

## 2026-08-30：拖动时揭示顶层放置区

提示词与图片共享的 `useFolderTreeDrag` 原本只能在树容器未被节点覆盖的空白处解析顶层目标，真实侧栏很难命中。两页现共享 `FolderRootDropTarget`：文件夹拖动激活后在树首行显示“移到顶层”，命中时高亮，松开向各自移动深命令提交 `destinationParent=null`；右键和移动 Dialog 保持为等价入口。

提示词公开工作区回归锁定右键与指针拖动共用 `move_prompt_folder`；图片公开回归同时证明不会误触素材移动。真实 Tauri 使用当前库嵌套提示词文件夹只读确认目标出现，随后以 Esc 取消且未写用户库；为避免把用户素材、提示词或目录带入版本库，不保留该实机截图与一次性脚本。完整前端 408 项、Rust Clippy、304 项核心及全部集成测试通过。

## 2026-08-30：Code review 修复

Standards/Spec 双轴审查发现：提示词使用错误的根节点称谓；新建创建器只拦自身取消，切库/关闭可能绕过全局草稿守卫；工作区测试仍直接导入内部实现；图片/提示词移动表单重复；拖放以 `string|null|undefined` 隐式编码目标；`PromptWorkspace` 同时承担导航、文件夹表单和中央协调。

修复后界面、规格、设计、任务、验证和实机脚本统一使用“提示词根位置”。`PromptCreateFocus` 挂载时冻结初始归属、登记 `setPromptDraftGuard`，复用抽出的 `PromptDraftGuardDialog`；返回、切范围、切库和关闭共享保存/放弃/留在当前页纪律。工作区行为测试改为只渲染 `PromptLibraryWorkspace` 公共 interface。

共享 `FolderDropTarget` 判别联合替代隐式三值；`folderPath.ts` 与 `FolderMoveTargetForm` 只共享路径计算和无业务状态表单，领域 mutation 保持分离。导航、文件夹 CRUD/拖动和内联输入迁入内部深模块 `PromptNavigator`，`PromptWorkspace` 只组合查询、选择、中央内容与领域 mutation。图片/提示词/聚焦编辑 152 条相关回归及 lint/typecheck 通过。

第二次 Standards 复审要求进一步收拢权威写入：创建、重命名、移动、删除和子树路径重映射现迁入 `promptFolderActions.ts`，工作区只提供统一 mutation 纪律、当前范围和导航 callback。`FolderPath::name` 删除 `unwrap_or` fallback，改用构造不变量的显式 `expect`；Rust 注释与测试把文件夹树节点统一称为“顶层文件夹”，不与无归属的“提示词根位置”混淆。

最终门禁更新为：`pnpm lint`、`pnpm typecheck`、46 个 Vitest 文件 411 项、17 个 Node 用例、`cargo clippy --workspace --all-targets -- -D warnings`、304 个核心测试及全部 Rust 集成/文档测试通过；两个 OpenSpec strict 校验通过。
