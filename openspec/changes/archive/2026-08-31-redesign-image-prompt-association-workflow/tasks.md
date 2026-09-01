## 1. 图片上下文关联台

- [x] 1.1 从 `AssetLibraryWorkspace` 公共 seam 编写失败回归，锁定单图/多图冻结目标、候选多选、部分已关联状态和实际新增关系数
- [x] 1.2 实现共用 `PromptAssociationDialog`，接替单图检查器与多选底栏的旧关联入口，并通过 1.1 回归

## 2. 新建并关联提示词

- [x] 2.1 从图片公共工作区编写失败回归，覆盖手写正文、单次创建、多图关联、创建失败草稿保留和创建后关联失败只重试关系
- [x] 2.2 实现图片上下文的新建表单、创建—关联两阶段状态与稳定错误呈现，并通过 2.1 回归
- [x] 2.3 接入现有全局提示词草稿守卫，覆盖关闭关联台、一级导航、切库和关闭窗口的三选一决议

## 3. 提示词关联图片预览

- [x] 3.1 从 `PromptLibraryWorkspace` 与 `PromptImageLinks` 公共 seam 编写失败回归，锁定有效封面初始预览、缩略图切换不导航、显式打开、删除态和解除回落
- [x] 3.2 实现主预览、缩略图选择、当前图片身份与显式打开动作，保留封面、解除、导入和刷新语义，并通过 3.1 回归

## 4. 视觉与响应式收口

- [x] 4.1 复用 Archive Desk token 完成关联台和图片预览的宽窄布局、键盘焦点、禁用/忙碌/错误状态，移除被替代的旧全局关联样式
- [x] 4.2 使用开发内存展台完成 1440/960/760 深浅主题交互检查，确认无水平溢出、无控制台错误且当前工作区上下文保持稳定

## 5. 完整验证

- [x] 5.1 串行通过 `pnpm lint`、`pnpm typecheck` 与 `pnpm test`
- [x] 5.2 串行通过 `cargo clippy --workspace --all-targets -- -D warnings` 与 `cargo test --workspace`
- [x] 5.3 运行 `openspec validate redesign-image-prompt-association-workflow --strict --no-interactive`，核对 proposal、spec、design、实现和任务状态一致
