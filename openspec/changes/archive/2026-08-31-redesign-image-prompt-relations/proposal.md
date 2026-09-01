## Why

图片与提示词的普通关联已经具备权威写入，但两个页面各自管理查询与缓存：从提示词侧写入后，图片检查器会继续显示 `staleTime: Infinity` 的旧关联；关联项也只是可解除文本，无法打开另一侧素材。关联因此既不一致，也不能承担用户在两类素材之间来回工作的核心任务。

## What Changes

- 建立独立的图片—提示词普通关联深 Module，以一个窄 interface 统一关系读取、建立/解除、封面规则、受影响端点 revision 和跨工作区定位。
- 图片检查器把关联提示词呈现为可打开的紧凑对象卡片；提示词检查器把关联图片呈现为可打开的缩略图卡片，解除关联退居次级菜单。
- “添加关联”使用搜索多选 Dialog：图片侧可一次关联多条提示词，提示词侧可一次关联多张图片；已关联项明确标记，不用消失制造困惑。
- 任一侧成功写入后，图片详情、提示词快照、卡片封面与关联计数在同一 revision 下失效并刷新；切换页面或重复选择不能继续显示旧关系。
- 关联对象在回收站中保持可见并可定位到对应回收站；永久删除后从两侧消失。跨页打开提示词时继续经过全局脏草稿守卫。
- 保留“从本地导入并关联”、逐项失败、已入库但未关联和封面确定性回落语义，不修改库格式或把普通关联解释为来源。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `asset-prompt-association`：增加双向可导航对象卡片、统一候选多选交互、跨模块 revision/缓存一致性和回收站定位要求。

## Impact

- 新增前端 `image-prompt-relations` 深 Module 及其生产/内存 Adapter；应用根注入现有 `WorkspaceNavigation` 和 TanStack Query 协调。
- 调整图片检查器 `AssetPromptLinks`、提示词检查器 `PromptImageLinks`、两个模块公共 props 与应用组合根，但不允许互相导入 `internal/`。
- 复用现有 `image_detail`、`prompt_snapshot`、`link_images`、`unlink_image`、`linked_image_states` 与 `set_prompt_cover` IPC；不新增依赖、不修改 SQLite 或侧车格式。
- 新增应用根公共行为测试、两侧关系 Module contract tests、匿名浏览器 fixture 与深浅/宽窄视觉验收。
