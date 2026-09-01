# UI 基础修复验收

日期：2026-08-27。范围：任务 7.6–7.10，修复基点为 `3ca21c457e2beed53eb0e9fbbad785af71b539d5`，不包含后续 8–11 节的功能实施。

## 失败回归与修复结果

| 问题 | 改动前的失败证据 | 修复后的验收 |
| --- | --- | --- |
| 迁移长列表 | 60 项真实冲突使确认区顶部位于 8993.84px，而窗口只有 900px 高 | 900px/600px 窗口内确认区底部恰为 900px/600px；冲突区独立滚动到第 60 项，首尾操作区仍可见；未全部选择不能提交，全部选择后完成内存迁移流程 |
| 展台滚动边界 | 外层无界高度阻止滚动到底部；截图复查及新增边界断言又发现内部列表溢出固定高度面板 | 外层限制为视口高度，内层面板使用有界网格轨道约束 ScrollArea；文件夹列表可独立滚动到第 14 项，不覆盖相邻空状态 |
| 搜索清除 | 受控组件卸载清除按钮后焦点落在 body；浏览器焦点断言失败；前次审查测得相邻控件偏移 36px | 鼠标、Enter、Space 和 Escape 清空后继续输入；空值状态不保留清除按钮焦点；搜索宽度与相邻排序位置稳定；禁用状态单测通过 |
| 主题选择 | ArrowRight 后深色选项仍未选中；原生化后的回归又捕获弹窗反向 Tab 落入未选项 | 原生单选 + 已选项唯一 tabIndex=0；四方向键循环、Tab/Shift+Tab、Space、标签点击和刷新后的非默认偏好保留均通过 |
| 紧凑文字 | 浏览器实测 compact 字号 11px，低于 12px 门禁 | 三个文字按钮均为 12px，仍高 28px，文字不截断、相邻按钮不重叠或换行；11px 元数据 token 不变 |

迁移复验使用开发入口新增的 `migration-many` 内存 port，渲染真实 `LibraryLifecycle`，没有复制 DOM 或访问实际素材库。主题反向 Tab 的根因已核对本地 Radix FocusScope：其焦点边界按 `tabIndex >= 0` 枚举，不识别原生单选组的选中关系；本次显式 tabIndex 只补全这一边界，不自行实现方向键。

## 浏览器复现

需要 Windows Edge、Python 和 Python `playwright` 包。先安装项目现有 pnpm 依赖；本次没有增加产品运行时依赖。以下命令在 `app/` 执行：

```powershell
python -X utf8 ../.agents/skills/webapp-testing/scripts/with_server.py --server 'pnpm exec vite --host 127.0.0.1 --port 4188 --strictPort' --port 4188 -- python -X utf8 -u scripts/ui-foundation-check.py --base-url http://127.0.0.1:4188 --case all
```

也可以先启动本仓库的 Vite 开发服务，再单独运行 `scripts/ui-foundation-check.py --base-url <本地地址>`。脚本支持 `--case migration|showcase|search|theme|typography` 单项回归，不依赖手动窗口或真实库数据。

- 5 项检查 × 深/浅主题 × 1440×900/760×600，共 20 组通过，没有页面运行时错误。
- 结果：`app/artifacts/ui-foundation/all-report.json`。
- 截图：同目录下的 `migration-*`、`migration-bottom-*`、`showcase-*`、`search-*`、`theme-*` 和 `typography-*`。
- 已查看窄窗口迁移页、深色窄窗口设置、浅色宽窗口设置等截图，操作区、选中态和键盘焦点环可见，未改变 Archive Desk 视觉方案。

## 工程门禁

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：58 个文件、374 项 Vitest 测试和 17 项 Node 测试通过。
- `pnpm build`：通过；仍有 Tauri window API 同时静态/动态导入的非阻断分包提示，本次未修改相关导入。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo test --workspace`：通过，包括 8 项 Tauri、295 项 core 单元测试及全部集成契约测试。
- `openspec validate redesign-image-library-workspace --strict --no-interactive`：通过。
- `git diff --check`：通过。

## 范围复查

已对照 `AGENTS.md`、本变更设计第 18 节和新增 app-shell 场景复查本轮差异：没有新增依赖、吞错/静默兜底、跨模块深层导入、前端像素处理或 Rust/迁移事务变更。测试通过公开组件触发交互；修复前失败与修复后通过均已实际执行。未发现本轮范围内新增的阻断问题。

`web-design-guidelines` 检查使用当日获取的[上游规则](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)，只覆盖本轮改动及其继承的焦点样式：

- `SearchField.tsx` / `SearchField.module.css`：标签、清除按钮名称、键盘激活及替代焦点样式通过。
- `SettingsDialog.tsx` / `SettingsDialog.module.css`：原生单选语义、可点击标签、单 Tab 停点及可见焦点环通过。
- `LibraryLifecycle.module.css` / `UiKitShowcase.module.css`：有界滚动和操作区可达；展台内部溢出问题在截图复查后补测试修复。
- `Button.module.css`：文字字号、紧凑高度、截断和继承的焦点样式通过。

批准的迁移安全约束优先于通用表单建议：全部冲突选择完成前仍禁用提交，不为套用通用建议改变产品规则。

此记录仅证明本次 UI 基础修复通过，并不代表整个前端或全部 OpenSpec 任务已经完成；不代替后续原生文件对话框、粘贴、真实素材库迁移和完整工作区的端到端验收。本轮没有提交、推送、合并或归档。
