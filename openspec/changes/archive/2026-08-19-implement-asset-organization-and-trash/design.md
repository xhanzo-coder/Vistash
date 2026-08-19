## Context

首个生产变更已经打通选库、导入、网格、预览与色卡，并预留了 `folders.json`、侧车中的 `folders`/`tags`/删除字段、回收站目录以及 SQLite 对应表。当前缺口不是数据形状，而是没有一个模块对这些字段的跨文件一致性负责，也没有任何操作界面。

本变更横跨权威元数据、派生索引、Tauri IPC 与 React 工作区。最危险的失败不是某个按钮报错，而是文件夹重命名只改了一半侧车、删除留下孤立本体、或索引与权威元数据长期分叉。因此设计重点是把一致性和回滚集中在一个深模块，而不是在每条 command 中分别拼装文件操作。

领域术语以仓库根 `CONTEXT.md` 为准：文件夹是逻辑节点，根文件夹不是持久化节点，回收站是库内区域，删除与清空回收站是不同操作。

## Goals / Non-Goals

**Goals:**

- 补齐文件夹、标签、文件名/标签搜索和单图预览操作，达到既有 v1 素材管理下限。
- 实现删除、回收站列表、还原和二次确认后的永久清空。
- 确保每次权威元数据变更可回滚、可由 SQLite 重建，并具有明确错误码。
- 在 10,000 条索引记录规模下，组合查询 release 基线不高于 200 ms；网格继续只请求视口邻近缩略图。
- 把现有无样式骨架提升为可持续扩展的 Windows 桌面素材工作区。

**Non-Goals:**

- 不实现智能文件夹、文件系统监控、批量重命名、去重面板或 PSD/RAW 专用预览。
- 不实现多用户、云同步、网络分享或跨库拖放。
- 不实现通用撤销栈；删除通过回收站恢复，组织操作失败通过事务回滚。
- 不实现提示词库或图像反推。

## Decisions

### 一、建立 `catalog` 深模块，Tauri command 不直接改侧车或索引

在 `vistash-core` 新增 `catalog` 模块，拥有 `Library` 与 `Index`，向命令层提供两类接口：

```text
Catalog::snapshot(AssetQuery) -> CatalogSnapshot
Catalog::{create,rename,delete}_folder(...)
Catalog::set_asset_folders(...)
Catalog::set_asset_tags(...)
Catalog::{delete,restore}_asset(...)
Catalog::purge_trash() -> PurgeReport
Catalog::index_imported(...)
Catalog::asset_ext(...)
```

`CatalogSnapshot` 一次返回当前查询结果、文件夹清单、标签及使用数量、回收站数量，使 React 不需要按“先列表、再标签、再计数”形成 IPC waterfall。调用方只学习领域操作，不学习 `folders.json`、侧车写入顺序或 SQLite 修复策略，符合 `codebase-design` 的深模块与 locality 原则。

`Opened` 改为持有 `Mutex<Catalog>` 与独立 `import_gate`。导入仍在不持有 catalog 锁时执行媒体处理，完成后短暂调用 `index_imported`；组织和回收站写操作由 catalog 锁串行化。备选“在 commands.rs 中直接调用 Library 与 Index”不采用，因为同一套一致性顺序会散落到十余条 command，测试只能复制实现细节。

### 二、使用有验证的领域值类型，不让任意字符串参与路径前缀替换

新增 `FolderName`、`FolderPath` 与 `Tag` 值类型：

- `FolderName` 去除首尾空白后必须非空，拒绝 `/`、控制字符、`.` 与 `..`。
- `FolderPath` 只能由已验证段构造，提供 `parent`、`join`、`is_descendant_of` 与前缀替换。
- `Tag` 去除首尾空白后必须非空且拒绝控制字符，按规范化后的字面值区分大小写。
- 根文件夹使用查询枚举 `FolderFilter::Root`，不以空字符串或“根文件夹”魔法值持久化。

备选“command 收 String 后到处临时检查”不采用：文件夹重命名涉及前缀关系，漏掉一次验证就可能把 `参考/构图` 与 `参考图` 错误混同。

### 三、权威元数据变更使用可注入失败的批量事务，索引失败则原地重建

`catalog` 内部实现 `MetadataTransaction`，只作为内部 seam：

1. 读取并保存全部将被修改文件的原始字节。
2. 使用既有原子写入分别提交新侧车与 `folders.json`。
3. 任一写入失败时，按逆序原子恢复已提交文件。
4. 权威文件全部成功后更新 SQLite。
5. SQLite 更新失败时删除派生索引并立即依据权威文件重新打开，重建成功后仍把原始索引错误返回给调用方；重建失败返回 `library.index_rebuild_failed`。

文件夹重命名和删除的测试通过事务观察者在第 n 个写入点注入失败，验证全部原始字节恢复。事务 journal 不持久化：现阶段只承诺处理 API 返回的写入失败，不承诺进程被强杀时的跨文件原子性；若真实故障显示需要崩溃恢复，再以独立格式变更引入持久 journal。

备选“先改索引再异步落侧车”不采用，因为索引可重建而侧车不可；权威方向不可反转。备选“为 SQLite 和文件系统实现真正两阶段提交”不采用，因为它会把一次本地元数据编辑提升为新的库格式与恢复协议，当前没有故障证据支撑该成本。

### 四、文件夹层级是路径集合，重命名与删除按完整段边界处理

`folders.json` 继续保存排序、去重的完整路径字符串，不改库格式版本。创建子文件夹要求父路径存在。重命名把目标路径及后代路径做段级前缀替换，并同步全部正常素材侧车；回收站侧车的 `deleted_from_folders` 保留历史字面值，不因正常文件夹重命名而改写。

删除文件夹按子树操作：删除节点与后代，正常素材移除落在该子树中的成员关系，其他成员关系保留；没有剩余关系即属于根文件夹。界面必须明确提示“删除文件夹不会删除素材”。

备选带稳定 UUID 的树节点不采用：当前公开格式已选择路径字符串，改用 ID 会引入格式迁移，而本变更没有出现路径重命名性能无法接受的证据。

### 五、查询以 SQLite 缩小候选集，以 Rust 完成 Unicode 文件名匹配

`Index::query_assets` 使用参数化 SQL 处理正常/回收站位置、精确文件夹和“必须同时具有全部标签”的集合条件，再在 Rust 中对候选文件名执行 Unicode `to_lowercase` 子串匹配。最终只为命中项加载标签、文件夹和色卡，按 `imported_at DESC, hash ASC` 排序。

选择根文件夹使用 `NOT EXISTS asset_folders`；标签清单通过正常素材联表聚合，回收站不计数。索引 schema 已能表达全部条件，因此 `INDEX_USER_VERSION` 不提升。

备选 SQLite `lower()` 不采用，因为默认 SQLite 的大小写转换只可靠覆盖 ASCII。备选前端过滤不采用，因为那要求把全库 DTO 和色卡先通过 IPC 传入浏览器，素材规模增长时浪费明显。

性能门禁使用不含媒体字节的 10,000 条索引 fixture，在 release 测量组合查询完整 DTO 的耗时；超过 200 ms 才评估 FTS 或额外索引，不提前引入 FTS5。

### 六、删除与还原用成对移动顺序和内存备份维持不变量

删除顺序：读取正常侧车 → 移动本体到回收站 → 写入更新后的回收站侧车 → 删除正常侧车。任一步失败时删除新侧车并把本体移回；原侧车在最后一步前始终保留。

还原顺序对称：读取回收站侧车并计算仍存在的文件夹 → 移动本体到正常树 → 写入正常侧车 → 删除回收站侧车。失败时删除新侧车并把本体移回。部分历史文件夹缺失时 `RestoreOutcome` 返回缺失路径供界面警告。

清空回收站逐素材处理。每个素材先读取侧车字节并删除派生缩略图，再把本体与侧车改名为 purge 临时名；先删除侧车临时文件，再删除本体临时文件。如果最后一步失败，本体改回且依据内存字节恢复侧车。成功项从索引移除，失败项完整保留并进入 `PurgeReport.failures`。

备选 Windows 回收站继续被现有主规格禁止。备选整批清空原子事务不采用，因为百 GB 级回收站无法为全部本体做第二份备份；单素材失败隔离与导入的回滚粒度一致。

### 七、IPC 按领域意图命名，一次刷新返回一致快照

新增 commands：

```text
catalog_snapshot(query)
create_folder(parent, name)
rename_folder(path, new_name)
delete_folder(path)
set_asset_folders(hash, folders)
set_asset_tags(hash, tags)
delete_asset(hash)
restore_asset(hash)
purge_trash()
```

写 command 返回操作结果或更新后的 `CatalogSnapshot`，前端成功后用一次 `catalog_snapshot` 刷新，不在组件中直接拼装索引状态。所有参数先转为核心值类型，错误继续使用 `{code, detail}`。文件 I/O 写操作在 blocking worker 中执行，避免重新引入窗口未响应。

### 八、界面采用“本地素材档案室”工作区，而非通用仪表盘

视觉方向是克制的编辑档案室：暖灰纸面、深墨导航、朱红危险/选中强调、细线索引标记。品牌标题使用本机可用的衬线字体栈，正文使用中文可读的系统字体；不加载网络字体，保持离线承诺。

素材一级入口内部形成三段：

- 左侧 240px 逻辑导航：全部素材、根文件夹、文件夹树、回收站及数量；文件夹操作紧邻选中节点。
- 主区顶部查询条：文件名搜索、标签 chips、结果数量；下方保持自适应缩略图网格。
- 单图预览在同一主区切换，增加标签编辑、文件夹多选与删除动作；回收站预览替换为还原动作。

危险的清空回收站使用 `role="dialog"` 的二次确认层，显示永久删除数量，默认焦点在取消。文件夹删除提示明确说明素材只回到根/其他文件夹。所有图标按钮有文本或 `aria-label`，键盘焦点具有高对比轮廓，遵守 `prefers-reduced-motion`。

不引入路由库或全局状态库。`AssetWorkspace` 管理查询与选中项，`App` 只管理库状态、一级导航与导入任务。查询输入使用 `useDeferredValue` 保持键入响应，成功写操作用一次快照刷新；静态配置和标签排序不放进渲染循环。

### 九、错误码扩展保持领域可诊断

新增：

- `library.folder_invalid`
- `library.folder_exists`
- `library.folder_not_found`
- `library.tag_invalid`
- `library.asset_metadata_write_failed`
- `trash.delete_failed`
- `trash.restore_failed`

继续使用既有 `trash.restore_target_folder_missing` 与 `trash.purge_failed`。错误文案表覆盖测试随 `ALL_CODES` 自动发现遗漏；不捕获后返回布尔值或默认成功。

### 十、测试 seam 是 Catalog 接口、IPC 包装与公开 React 工作区

按 TDD 纵向推进：

1. `Catalog` 公共接口测试文件夹创建/重命名/删除、标签幂等、组合查询。
2. 通过故障注入观察者测试多侧车回滚与删除/还原成对不变量。
3. 删除索引重建，比较文件夹、标签、删除状态和查询结果等价。
4. `src/shared` 用 Tauri 官方 mock 锁定 command 名、参数和 DTO。
5. `AssetWorkspace` 组件测试查询、文件夹切换、标签编辑、删除/还原和 purge 二次确认。
6. Windows release 实测真实素材的键盘焦点、对话框和文件移动结果。

测试只跨上述公开 seam，不断言私有 helper 调用次数。

## Risks / Trade-offs

- **风险：文件夹重命名需要改写大量侧车。** → 先收集完整变更集并按事务 seam 回滚；记录 1,000 个受影响侧车的 release 基线，超过 2 秒再引入后台进度 Channel。
- **风险：索引锁使查询与组织写操作串行。** → 写入均为使用者显式短操作，导入媒体处理不持锁；真实测量出现竞争后再评估读写连接分离。
- **风险：路径字面大小写区分可能与 Windows 文件夹直觉不同。** → 文件夹是逻辑节点而非 NTFS 路径，界面始终显示完整路径；本变更不做不可靠的跨语言 case folding。
- **风险：purge 恢复步骤本身可能失败。** → 使用明确 `trash.purge_failed` 保留底层原因；不静默跳过。此类双重磁盘故障无法由单进程算法绝对消除，后续若出现真实案例再引入持久恢复 journal。
- **风险：工作区视觉精修扩大前端改动。** → 只重构素材入口和共享样式，不改提示词占位结构；布局使用原生 CSS，不新增 UI 框架。

## Migration Plan

1. 增加领域值类型、`Catalog` 与失败注入测试，不接入 Tauri。
2. 实现文件夹、标签、查询，再接入 IPC 和基础工作区。
3. 实现删除、还原、purge 与回滚测试，再接入危险操作界面。
4. 用既有库打开并全量重建索引，验证格式版本不变且已有素材无迁移。
5. 运行 10,000 条索引查询、1,000 侧车文件夹重命名基线与 Windows 交互验收。

回滚代码不会删除或降级库数据：本变更只写入当前格式已存在的字段。若回退到旧版本，文件夹和标签仍保留在侧车与 `folders.json` 中，只是旧界面不提供编辑入口；回收站内容仍受旧版去重检测保护。

## Open Questions

无。文件夹多成员关系、标签大小写、组合查询 AND 语义和回收站粒度已在本设计与规格中确定。
