## 背景与目标

用户已批准修复合并审查的五项问题并在验收后合并。只修复旧分支已承诺的行为，不扩展新建提示词入口、反推或视觉重构。沿用归档变更已批准的组件 seam：App 的原生事件边界、NoteAutoSaveEditor 用户输入/错误呈现、PromptWorkspace 查询/草稿交互、两瀑布流与列表的选择/聚焦行为；测试只模拟 IPC、时间和浏览器几何等外部边界，不以私有状态自证。

## 决策

1. 原生订阅错误在所属界面持久呈现，提示无法获得的能力及原始原因。关闭保护错误使用独立状态，不能被普通导入成功清除；关联区独立记录拖放不可用状态并改文案。保留已有显式非 Tauri 环境判断，但不吞真实 Tauri 错误。拒绝“捕获后继续假装成功”。
2. 备注挂载状态在每次 effect setup 恢复，cleanup 仍负责保留草稿与补写。以实际 StrictMode 组件回归证明失败/成功呈现，不删除 StrictMode 绕过问题。
3. 查询意图集中经过现有 `blockIfPromptDraftDirty`，在守卫确认后关闭聚焦并更新查询。文本输入捕获值而非延迟读取事件；包含标签、文件夹、收藏、回收站、条件移除等入口。拒绝只补收藏按钮导致同类入口继续丢稿。
4. 提示词两视图增加明确聚焦回调；Enter 仅在集合项目命中区处理，附属按钮保留自身语义，双击只接在项目命中区。
5. 框选通过共享手势模块完成捕获、坐标转换、几何相交、滚动更新和取消，仍由现有 SelectionModel 作为唯一选择权威。从背景主键开始，移动超过 4 CSS px 才进入框选，点击和拖框互不误触；Ctrl/Cmd 的基准是 pointerdown 时的选择。矩形使用既有强调/焦点 token，无新品牌样式与动效。
6. 位置继续来自已锁定 TanStack virtual-core 3.17.8。其声明中的公开 `measurementsCache` 提供完整虚拟几何，读取前以公开 `getTotalSize()` 完成布局计算，不调用 private `getMeasurements`、不修改缓存、不重新实现瀑布流定位器。坐标包含 `lane`、`start`、`size`，去掉项目间距；框选不依赖 DOM 项目数量。按鼠标帧节流，10,000 项下检查 DOM 有界与手势时间；查询/宽度变化取消进行中手势。

## 技术事实来源

Windows release 补验发现：聚焦阅读的集合触发项卸载后 activeElement 退到 body，必须让阅读区域在挂载时 focus；不能只用向 section 手动派发 Escape 的测试自证。主窗口原 `core:default` 权限不含 `core:window:allow-close`，导致草稿解决后继续关闭被 ACL 拒绝；仅为 main 增加该最小权限，同时显式呈现关闭命令拒绝。

继续关闭的 SDK 流程还会调用 `destroy`，因此 main 同时需要 `core:window:allow-destroy`。应用在关闭事件中始终 preventDefault：脏草稿先询问，解决后重新 close；无草稿时显式 destroy 并捕获该阶段的拒绝，避免 SDK 自动销毁的异步错误无人呈现。两项权限只作用于 main，不扩展文件或网络访问。

- [React StrictMode](https://react.dev/reference/react/StrictMode)：开发模式额外运行 effect setup/cleanup，用于暴露缺少对称清理的问题。
- [Tauri Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)：原生事件注册返回 Promise，监听需要在生命周期结束时释放。
- [TanStack Virtualizer](https://tanstack.com/virtual/latest/docs/api/virtualizer)：多 lane、虚拟项目位置与可见项职责继续属于虚拟化器。完整缓存访问以本项目锁定版本的 TypeScript 公开声明为依据，由回归测试约束升级风险。

## 风险与备选

复审补充：可能改变查询成员的组织写入统一在 `runMutation` 发出 IPC 前经过草稿守卫；只保护写入后的 `selectFolder` 不足以防止旧查询刷新卸载编辑器。框选 reducer 以一次查询 ID Set 完成合法性检查，避免每帧 k 次线性查找产生 O(k×n) 开销；10,000 个 64 字符身份全命中必须在 50ms 内完成状态更新，真实界面另测手势耗时。

- 框选与虚拟化、焦点冲突 → 不使用全量 DOM、不从按钮/文本控件开始拖框，取消恢复原选择，真实浏览器补验。
- 订阅失败时原生关闭仍可能发生 → 明确持续告警；不声称前端能替代已失败的原生事件机制。
- 全量几何命中为 O(n) → 只在手势进行时按帧计算，万项测试验证；不提前引入空间树。
- 单分支修复会遗漏正在重构的后代 → 保留历史合并后将 main 合入重构分支，再运行其全部门禁。

## 迁移与验收

无数据格式迁移。每项先建立失败行为测试再修复，立即更新 tasks；最后串行通过前端/Rust门禁、production 构建、Windows release 交互验收、两轴审查和 OpenSpec 严格校验。任务全部通过后推送旧分支，经 PR 普通 merge 合并 main；随后同步至重构分支。当前授权为修复与合并，已完成变更的归档及主规格同步另行确认，不擅自选择归档选项。若验收阻断，保持分支不合并。

## 待确定问题

无。本轮不处理审查报告另列的新建提示词入口需求。
