# Vistash Agent 开发规范

## 项目使命

Vistash 是一个 Windows 优先、本地优先的桌面应用，只覆盖两项能力：

1. **本地图片素材管理**：素材复制进库；库格式由本项目定义并公开记录，采用内容哈希寻址与人类可读的元数据文件，SQLite 索引可仅依据元数据完整重建。
2. **图像反推提示词**：基于图像的可观察证据，生成能在指定生图模型上重建主体、构图、风格机制、光色与材质的控制提示词，并保留可编辑的结构化观察结果。

产品目标必须表述为"生成能在指定生图模型上重建相似视觉语言的控制提示词"，不得表述为"还原图像生成时使用的原始提示词"，因为从单张成图无法唯一恢复历史提示词字符串。

项目明确排除从网页站点批量抓取素材，包括浏览器扩展与内置浏览器采集。素材管理层的深度为"够用即可"，不对标 Eagle 全功能；立项动机是反推能力缺口，而不是规避 Eagle 的一次性授权费用。

运行时技术栈已正式采用 Tauri 2、React/TypeScript、Rust 与 SQLite，更换其中任一项必须通过新的 OpenSpec 变更完成并说明原技术为何不再适用。其余实质性架构决策仍必须先通过 OpenSpec 审批，之后才能初始化应用或编写生产代码。

## 语言规范

- 面向用户的回复、项目文档、OpenSpec 产物、任务说明、代码注释和提交说明统一使用简体中文。
- Skill 名称、代码标识符、命令、文件路径、协议名、库名以及 OpenSpec 固定解析语法保留原文。
- Markdown、YAML、JSON、TOML、HTML、CSS、JavaScript、TypeScript 和源代码文件统一使用无 BOM 的 UTF-8。

## 事实来源

1. `openspec/` 下的 OpenSpec 产物定义已经批准的产品和工程变更。
2. 本文件 `AGENTS.md` 定义 Codex 与 Claude 共用的规范开发流程。
3. `CLAUDE.md` 增加 Claude 专用调用方式，并且必须与本文件保持一致。
4. 某个 Skill 被选中后，其 `SKILL.md` 决定该 Skill 的具体执行方式。

如果发生冲突，优先遵守仓库安全规则，其次遵守当前有效的 OpenSpec 变更，再遵守本文件，最后遵守 Skill 的实施细节。

## Skill 所有权与发现入口

- `.agents/skills` 是当前项目的 Skill 中心。
- `.codex/skills` 和 `.claude/skills` 均为指向项目中心的 junction，因此 Codex 与 Claude 能发现同一组 Skill。
- 19 个可复用工程 Skill 和技术 Skill 均通过 junction 指向开发者本机的中央 Skill 库；公开仓库不依赖某个开发者的绝对路径。
- `openspec-propose`、`openspec-explore`、`openspec-apply-change` 和 `openspec-archive-change` 是当前项目拥有的 OpenSpec 生成目录。它们是中央化策略的明确例外，因为 `openspec update` 会按当前仓库使用的 OpenSpec 版本管理它们。
- 除非用户明确要求修改中央原件并理解会影响所有引用项目，否则不得编辑 junction 背后的 Skill。
- 不得手工把可复用 Skill 复制进当前项目。必须使用 `e8-skill-linker`，并在实际链接前先运行 dry-run。

## 强制 OpenSpec 流程

实质性功能、缺陷修复、重构、数据库结构变更、迁移、架构决策、构建流水线和发布变更都必须建立 OpenSpec change。

1. 使用 `openspec list`、`openspec list --specs` 和 `openspec status --change <change-id>` 检查当前状态。
2. 使用 `openspec new change <verb-noun>` 创建 kebab-case change，或者选择一个已有的有效 change。
3. 依次完成 `proposal.md`、能力规格、必要时的 `design.md` 和 `tasks.md`。编写每类产物前运行 `openspec instructions <artifact> --change <change-id>`。
4. 所需产物未完成、验收场景不可测试时，不得修改生产代码。
5. 每次只实施一个任务；只有对应测试或检查通过后，才能勾选该任务。
6. 必须立即同步 `tasks.md`；聊天记录和口头状态不是进度事实来源。
7. 完成前运行 `openspec validate <change-id> --strict --no-interactive`，并运行全部相关项目测试。
8. 只有已经完成且校验通过的 change 才能通过 `openspec archive <change-id> -y` 归档。

仅修改文字、注释或格式且完全不影响运行时、数据、构建、测试和发布行为时，可以豁免新建 OpenSpec change，但必须明确说明豁免原因。

## 工作目录与命令

本仓库有**两个工作目录**，命令不通用。这不是记性问题：`openspec` CLI 按当前工作目录解析 `openspec/`，在 `app/` 下运行 `openspec status` 会得到 `No changes exist` 这种误导性报错。变更 `implement-vistash-import-and-browse` 的设计第十条已把这项代价记为已接受，代价的缓解办法就是本节。

| 工作目录 | 归它的命令 |
| --- | --- |
| 仓库根 `05. Vistash/` | 全部 `openspec` 命令 |
| `app/` | 全部 `pnpm` 与 `cargo` 命令 |

### 四条门禁命令

修改生产代码后必须全部通过，全部在 `app/` 下运行：

```powershell
pnpm lint                                              # oxlint --type-aware
pnpm typecheck                                         # tsc --noEmit
pnpm test                                              # vitest run
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`cargo clippy` 与 `cargo test` 合起来算一条门禁（Rust 侧）。四条的完整含义是：前端 lint、TypeScript 类型检查、前端测试、Rust 检查。

关于 `pnpm lint` 为何是 `oxlint` 而不是 `eslint`：见 `implement-vistash-import-and-browse` 设计的第十一条。简述是 `typescript-eslint` 稳定版不支持本项目使用的 TypeScript 7，而 `oxlint-tsgolint` 恰恰要求 TypeScript 7 以上。

`pnpm test`（`vitest run`）是第四条门禁。前端测试自首个纵向切片（`3704ff6`）起就已存在，当前覆盖 IPC 封装与素材视图；本文件此前记载的"没有前端测试文件因而会失败"从那次提交起即已过期。

**不要把前端门禁与 Rust 门禁并行运行。** `vitest` 的 forks worker 有 60 秒响应超时，而 `cargo test --workspace` 与 `cargo clippy --all-targets` 的全量编译会占满 CPU。两者同时跑时 `pnpm test` 会以 `Failed to start forks worker` 和 `Timeout waiting for worker to respond` 失败，看上去像 pool 配置缺陷。它是 CPU 饥饿：串行运行时同一批用例数秒内全部通过。因此不要为这个现象去改 `vitest` 配置或改用 `--pool=threads`——那会把一次调度问题固化成一处无谓的配置分叉。

### 构建前置条件

以下三项缺失会使 `cargo` 与 `pnpm tauri dev` 失败，且报错信息通常指不到真正原因：

- **Rust 工具链**：`stable-x86_64-pc-windows-msvc`。当前验证通过的版本是 `rustc 1.97.1`；workspace 声明的下限是 `rust-version = "1.82"`。
- **MSVC 生成工具**：Rust 的 MSVC 目标依赖它做链接。本机位置是 `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`。
- **WebView2 运行时**：Tauri 在 Windows 上的渲染层。Windows 11 自带，开发无需额外安装；分发时的引导安装留待打包变更处理。

`cargo` 可能不在 PowerShell 的 `PATH` 中。此时用 `$env:USERPROFILE\.cargo\bin\cargo.exe`，或先执行 `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"`。

## 全部 Skill 的使用顺序

下面是已安装项目 Skill 的相对顺序。只调用符合当前任务触发条件的 Skill；如果要跨阶段改变已选择 Skill 的相对顺序，必须在当前 OpenSpec 设计中记录原因。

### 阶段 A：仓库初始化

1. `project-init`：首次进行需求拆解、技术选型、目录结构和编码规范设计。
2. `setup-matt-pocock-skills`：首次使用 Matt Pocock 工程流程前初始化其 Issue 与领域文档约定。
3. `setup-pre-commit`：只有真实的 lint、类型检查和测试命令已经可运行后才配置；不得为尚不存在的工具链创建占位 hook。

### 阶段 B：调研、建模与提案

4. `research`：API、依赖版本、Windows 行为、文件格式、性能特征或其他事实存在不确定性时，基于高可信一手资料调研，并把结论写入当前 OpenSpec 产物。
5. `domain-modeling`：定义或修改 Asset、Library、Folder、Tag、Smart Folder、Thumbnail、Original File、Sidecar、Index、Duplicate Set 等领域概念、约束和所有权。
6. `grill-with-docs`：需求或架构仍有歧义时，通过集中提问消除不确定性，并把 ADR 和术语表写入 OpenSpec。
7. `openspec-explore`：在尚不适合承诺方案时探索问题、比较方向，不编写生产代码。
8. `openspec-propose`：为明确的实质性变更生成中文 proposal、specs、design 和 tasks；这些产物完成前不得进入生产实施。

### 阶段 C：风险验证与设计

9. `prototype`：只针对明确的不确定性使用，例如虚拟网格性能、缩略图吞吐量、文件监控或拖放行为。原型默认可丢弃，除非后续任务明确批准复用。
10. `codebase-design`：需求明确后定义模块边界、公开接口、依赖方向和测试接缝。
11. `frontend-design`：在生产界面精修前定义视觉层级、交互模型、素材网格、预览器、筛选器、键盘流程和自适应行为。
12. 回到 OpenSpec 完成或修订 `design.md` 与 `tasks.md`，记录已选方案、被拒绝方案、风险、迁移和验收检查。

### 阶段 D：技术栈实施

13. `tauri-v2`：用于 Tauri 项目结构、command、IPC、capability、permission、文件系统访问、插件、Windows 打包和 updater。
14. `rust-best-practices`：用于 Rust 所有权、错误类型、并发、I/O、图片处理、索引、性能分析、Clippy 和 Rust 测试。
15. `vercel-react-best-practices`：项目目录名为 `react-best-practices`；用于 React 组件结构、渲染性能、bundle 大小、数据流和大列表行为。
16. `tdd`：在修改生产行为前建立失败测试或可复现的验收检查，按红—绿—重构循环推进。
17. `openspec-apply-change`：读取当前 change 的上下文和任务，逐项驱动实施，并在每项验证通过后立即更新复选框。
18. `implement`：按照当前 OpenSpec 设计和已启用技术 Skill，把当前任务实现为最小但完整的纵向切片。

### 阶段 E：诊断与验证

19. `diagnosing-bugs`：行为失败、偶发错误、不正确或变慢时使用。先诊断根因，再回到 `tdd` 和 `implement` 修复，不得猜测式改代码。
20. `webapp-testing`：验证 React 界面、本地开发页面、浏览器日志、键盘操作和视觉状态。Windows 原生对话框、Shell 和拖放行为还必须进行 Windows 层交互测试。
21. `web-design-guidelines`：功能正常后审查可访问性、焦点、语义、键盘导航、动画、图片加载、虚拟化和用户体验。
22. `code-review`：完成变更后同时按仓库规范与当前 OpenSpec 需求进行审查，存在问题时回到相应实施阶段。

### 阶段 F：自动化、发布与归档

23. `workflow-automator`：只有本地构建和测试命令已经通过后，才基于已验证命令创建 CI、打包、发布或 Git hook 自动化。
24. 再次运行 `code-review`、完整相关测试和 OpenSpec 严格校验。
25. `openspec-archive-change`：只有全部任务完成且验证通过后，才把 change 归档并同步主规格。

## 工程门禁

- Tauri、Rust、React、SQLite、Windows、图片格式、安装器、签名和更新必须优先参考官方文档。
- UI 渲染必须与文件系统、索引、数据库和媒体处理职责分离。
- 图像解码、尺寸缩放、缩略图生成和色卡计算必须在 Rust 侧完成。界面层不得承担像素级图像处理，包括通过 `Canvas` 或 `OffscreenCanvas` 读取像素数据执行聚类或缩放。
- 应用不得内置任何模型供应商的 API 密钥或等价凭据。凭据必须由使用者提供并保存在本机，视觉理解能力必须实现为可替换的 provider 接口。
- 所有文件系统和数据库写操作都必须具有明确错误语义与测试，不得加入静默 fallback。
- 性能敏感工作必须说明数据规模和可度量门禁；按需覆盖启动时间、内存、缩略图吞吐量、索引吞吐量和滚动响应。
- 任务只有在实现、测试、OpenSpec 任务状态和相关文档一致时才算完成。
