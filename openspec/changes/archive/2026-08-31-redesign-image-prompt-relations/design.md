## Context

普通关联的权威数据已经由提示词侧车与 Catalog 反向索引维护，但前端所有权分裂：图片模块用 TanStack Query 缓存 `image_detail`，提示词工作区使用自己的快照刷新；两个关联组件分别调用 IPC、筛候选和呈现错误。`asset-library/index.ts` 注释声称存在模块级失效事件，实际没有实现。匿名浏览器 fixture 已稳定复现：后端新增关联后，图片检查器仍显示 `staleTime: Infinity` 的旧关系。两侧关联项同时缺少 `WorkspaceNavigation.requestLocate` 入口。

依赖属于 local-substitutable：生产 Adapter 使用现有 Tauri IPC/SQLite，测试 Adapter 使用 `mockIPC`；导航已有生产实现与内存 fake。关系 Module 不需要新增远程 port 或第三方依赖。

## Goals / Non-Goals

**Goals:**

- 让图片与提示词两侧读取同一关系 revision，任一侧成功写入后两侧立即一致。
- 让关联对象成为可打开、可识别、可处理删除态的双向导航对象。
- 统一候选搜索、多选、重复关联、部分失败和封面约束，同时保持两侧不同视觉身份。
- 保持两个工作区深模块边界，不允许互相导入 `internal/`、query key 或 store。

**Non-Goals:**

- 不修改普通关联为有方向或有类型关系，不记录生成来源、反推来源或生成历史。
- 不修改 SQLite、侧车格式、图片本体或提示词正文，不新增路由库。
- 不抽取图片/提示词通用检查器或 `GenericWorkspace<T>`，不实现图像反推。

## Decisions

### 1. 建立 `image-prompt-relations` 深 Module

外部 seam 暴露 `registerRefresh(library, adapter)`、`execute(command)` 与 `open(target)` 三类意图。工作区只注册自己的读取刷新 Adapter；单调 revision、受影响 ID、执行次序与刷新聚合全部留在 Module 内部，不向 React 组件暴露快照或 query key。`subject/target` 使用 `image | prompt` 判别联合；`command` 使用 `link | unlink | set_cover` 判别联合。Interface 同时包含不变量：同库、重复建立幂等、回收站关联保留、封面只能指向正常关联图片、逐关系错误稳定返回。

Implementation 隐藏 IPC 写入编排、按库队列、刷新屏障、刷新错误与正常区/回收站定位。图片候选、提示词候选与两侧对象投影是各自工作区的可视查询，继续由领域组件读取；它们必须在 Module 的刷新 Adapter 内失效，但不塞进一个 `GenericRelationView`。删除该 Module 会让写入顺序、跨页定位和双侧一致性重新散回两个检查器，因而它提供真实 Depth、Leverage 与 Locality。

备选是新增一个无 payload 的“关联变化事件”。它只能修复刷新，仍让两侧重复读取、写入、候选、删除态和导航规则，因此拒绝。

### 2. 应用级 revision 是关系一致性的唯一前端事实

每个 `LibraryId` 在 Module 内维护一条写入—刷新队列和受影响的图片/提示词 ID 集合。`execute` 只在权威 IPC 成功后调用本库全部刷新 Adapter，并在它们完成后才兑现成功；同库下一次写入必须等上一次刷新完成，从结构上禁止旧读取在新写入后覆盖 UI。写入成功但刷新失败通过独立 `refreshError` 报告，不能回滚、清空提交选择或冒充写入失败。导入并关联、图片/提示词删除与还原由自己的权威事务执行，事务完成后必须调用 `synchronize` 进入同一刷新队列。切库按库隔离；组件卸载只注销自己的刷新 Adapter。

备选是把图片详情 `staleTime` 改成零或每次激活全量刷新。它会把明确的关系写入退化为隐式轮询，并扩大 IPC 与 10,000 项工作区成本，因此拒绝。

### 3. `open` 复用现有导航与草稿守卫

关系 Module 接收 `WorkspaceNavigation` Adapter。打开提示词发出 `locate_prompt`，打开图片发出 `locate_asset`；删除态决定目标是活动区还是回收站。应用根现有 guarded navigation 继续负责提示词脏草稿三选一，不在关系组件复制确认逻辑。来源工作区保持挂载，使用者点击一级入口即可恢复原滚动与选择。

### 4. 共享关系事实，不共享两侧 UI

图片侧以正文/标题为主的紧凑提示词行；提示词侧以缩略图和显示文件名为主的图片格位。整行/整格点击打开对方，解除关联进入次级菜单。两侧“添加关联”均使用搜索多选 Dialog：候选提供足够识别信息，已关联项显示状态而非静默消失，提交前显示关系数量摘要。提示词侧额外保留“从本地导入并关联”和封面菜单。

### 5. 测试穿过公共组合 seam

关系 Module 用内存 Adapter 做 contract tests；跨页打开和双侧写后即读从 `App` 公共组合入口测试；图片、提示词工作区只测试各自对象卡片与 Dialog 的可观察行为。旧的两套浅关联协调测试在新 interface 覆盖后删除，避免层叠测试。

## Risks / Trade-offs

- [Risk] revision 发布早于缓存失效完成造成短暂旧 UI → `execute` 在刷新协调完成后才兑现成功，订阅快照携带 phase。
- [Risk] 多图片 × 多提示词形成大量关系 → 提交前显示数量，按已批准批量大小分块并逐关系报告，不在前端生成图片字节。
- [Risk] 删除态导航与永久删除竞速 → 打开前使用关系快照位置，目标缺失返回稳定错误并刷新关系。
- [Trade-off] 增加一个应用级 Module → 换取两侧一致性、导航和测试 Locality；不增加依赖或库格式。

## Migration Plan

1. 以匿名 fixture 增加跨页导航与提示词侧写入后图片详情保持旧缓存的失败回归。
2. 建立关系 Interface、Tauri Adapter、内存 Adapter 和按库 revision store。
3. 先接入现有两侧读写并替换重复失效，再接入 `open`。
4. 重做两侧对象卡片与添加 Dialog，保留本地导入和封面行为。
5. 运行公共行为、深浅/宽窄浏览器、10,000 项性能和完整门禁；失败时回退前端提交，不涉及数据迁移。

## Open Questions

无阻断问题。首版不增加跨页历史栈；来源工作区依靠既有挂载状态和一级入口恢复。
