# 图片—提示词关联工作流验收

## 实现结果

- 图片单选与多选共用冻结目标的关联台；候选支持跨搜索多选、部分已关联说明和真实新增关系计数。
- 图片上下文可手动新建一条提示词并关联全部冻结图片；创建失败保留草稿，关联失败保留提示词，刷新失败只重试刷新。
- 新建模式接入全局提示词草稿守卫，直接关闭与外部导航使用同一三选一决议。
- 提示词关联图片改为有效封面优先的主预览与缩略图选择；缩略图切换不导航，显式打开才定位图片工作区。
- 主预览与缩略图均呈现身份、尺寸、封面和删除态；封面、解除、图片库选择、本地导入和回收站定位保持原语义。

## 自动化门禁

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：48 个测试文件、429 项 Vitest 回归通过；17 项 Node 合同测试通过。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo test --workspace`：392 项 Rust 单元与集成测试通过，Doc tests 通过。
- `openspec validate redesign-image-prompt-association-workflow --strict --no-interactive`：通过。
- `git diff --check`：通过。

## 浏览器与视觉验收

- `scripts/association-workflow-check.py` 在图片关联台与提示词图片画廊上完成深浅主题 × 1440/960/760 共 12 个交互状态。
- 所有状态无水平溢出、无浏览器控制台 warning/error；窄屏关联台上下排列，提示词检查器覆盖层保持当前工作区现场。
- 截图与机器报告保存于 `app/artifacts/association-workflow/`。

## 终审

- Web Interface Guidelines：所改交互控件具备标签、键盘与可见焦点；图片尺寸与替代文本明确；长候选与缩略图使用上限或 `content-visibility`；无 `transition: all`、无无替代的 outline 移除。
- Code review Standards 轴：PASS。
- Code review Spec 轴：PASS。终审期间发现并修复跨搜索计数、混合失败刷新顺序和缩略图尺寸三个问题，并增加公共回归。
