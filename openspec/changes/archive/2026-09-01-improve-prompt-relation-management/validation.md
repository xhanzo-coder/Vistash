# 关系管理与多图卡片验证

日期：2026-09-01。

## 用户决策

- 图片侧与提示词侧都要能直接解除具体关系，不能只藏在 `···` 菜单。
- 提示词卡片只显示一张代表封面，不做四宫格；显式封面优先，否则使用第一张有效关联图片。
- 多图卡片直接显示关联总数 `N 张`；完整图片集合继续在详情的主预览＋缩略图画廊中展开。

## 红—绿行为回归

三个红灯分别稳定证明：图片侧没有直接解除按钮、提示词缩略图没有直接解除按钮、五图卡片仍显示 `+4`。实现后图片工作区、提示词关联画廊、提示词卡片和关系协调器 4 个文件共 140 项通过：

- 直接按钮具有包含目标标题/文件名的可访问名称，并与打开提示词/切换预览的主体按钮分离；
- 两侧直接按钮和原菜单都复用既有 `unlink_image` mutation；解除后双方 revision 刷新，素材仍存在；
- 五图卡片只有一个 `.prompt-cover-frame`，显示“5 张”；无显式封面时只请求后端解析出的一个 `resolved_cover_hash`。

## 视觉与可访问性

`association-workflow-check.py` 增加 `asset-unlink` 状态，并复验 `asset-unlink`、`asset-association`、`prompt-gallery` × 1440/960/760 × 亮暗主题，共 18 个匿名 fixture 状态。结果：

- 控制台 warning/error 与 pageerror 为 0；
- 图片工作区、提示词工作台和关联 Dialog 水平溢出为 0；
- 宽屏通过关联主体键盘聚焦触发 `focus-within`，broken-link 按钮可见；当前提示词缩略图直接动作可见；
- `hover:none` 与 `<=780px` 让直接动作常驻，窄窗口仍保留独立主体命中；
- 动画只使用 opacity/transform，且 `prefers-reduced-motion` 下禁用 transition；
- icon-only 按钮均有 `aria-label` 和原生 `title`，卡片数量虽为装饰文本，但卡片 `aria-label` 已包含完整关联图片数。

Web Interface Guidelines 审查未发现阻断：所有动作使用语义化 `<button>`，焦点样式由标准 `IconButton` 提供，关系解除不删除任何领域对象且可通过重新关联恢复，因此维持规格明确批准的无删除确认流程。

Standards/Spec 双轴终审最终均为 PASS。Standards 首轮只发现 `PromptCardWaterfall` 注释仍写旧 `+N`，已同步为关联总数 `N 张`；两处 CSS 显隐逻辑虽然形状相似，但定位、动画方向与背景不同，保留局部实现比制造通用抽象更清晰。Spec 未发现缺失、scope creep 或错误实现。

## 完整门禁

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：48 个 Vitest 文件、431 项通过；26 项 Node 合同测试通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo test --workspace`：Tauri crate 12 项、核心 crate 304 项及全部集成/文档测试通过。
