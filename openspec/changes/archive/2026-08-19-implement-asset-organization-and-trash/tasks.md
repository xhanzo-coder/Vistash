## 1. 领域值与错误语义

- [x] 1.1 先为 `FolderName`、`FolderPath`、`Tag` 的合法值、规范化与非法输入建立失败测试
- [x] 1.2 实现文件夹与标签值类型、根文件夹查询枚举和段级前缀替换，使 1.1 全部通过
- [x] 1.3 新增 `library.folder_*`、`library.tag_invalid`、`library.asset_metadata_write_failed`、`trash.delete_failed` 与 `trash.restore_failed`，同步序列化、唯一性测试和前端中文文案

## 2. Catalog 深模块与查询

- [x] 2.1 先为 `Catalog::snapshot` 建立公共接口测试，覆盖正常/回收站位置、根/精确文件夹、Unicode 文件名子串与多标签 AND 组合
- [x] 2.2 建立 `Catalog`，接管 `Library` 与 `Index`，实现一致快照、`asset_ext`、导入后索引写入和索引失败重建
- [x] 2.3 扩展 `Index` 的参数化候选查询、标签使用数量和稳定排序，使 2.1 通过且不加载未命中素材色卡
- [x] 2.4 构造 10,000 条无媒体索引 fixture，记录 release 组合查询基线并验证不高于 200 ms

## 3. 文件夹与成员关系

- [x] 3.1 先建立文件夹创建测试，覆盖父路径存在、规范化后重复和非法名称，再实现 `Catalog::create_folder`
- [x] 3.2 先建立素材多文件夹、移除到根和不存在目标测试，再实现 `Catalog::set_asset_folders`
- [x] 3.3 先建立文件夹重命名测试，覆盖后代路径与全部相关侧车，再实现段级批量重命名
- [x] 3.4 为第 n 个权威文件写入失败建立注入测试，实现 `MetadataTransaction` 并验证重命名时全部原始字节恢复
- [x] 3.5 先建立文件夹子树删除测试，验证素材不删除、其他成员关系保留和必要时回根，再实现批量删除与回滚
- [x] 3.6 删除 SQLite 索引后重建，验证空文件夹、层级、素材成员关系和查询结果与变更前权威元数据一致

## 4. 标签

- [x] 4.1 先建立标签添加、重复添加、移除不存在标签和非法标签测试，再实现 `Catalog::set_asset_tags`
- [x] 4.2 建立正常素材标签清单与使用数量测试，验证回收站素材不计数且索引重建结果相同

## 5. 删除、还原与清空回收站

- [x] 5.1 先建立多文件夹素材删除和每个阶段失败的测试，再实现本体/侧车成对移动与删除回滚
- [x] 5.2 先建立完整还原、部分文件夹缺失、全部文件夹缺失和阶段失败测试，再实现 `RestoreOutcome` 与还原回滚
- [x] 5.3 先建立 purge 成功、单素材失败隔离、缩略图清理和失败素材完整保留测试，再实现 `PurgeReport`
- [x] 5.4 删除并重建索引，验证正常/回收站集合、删除状态、标签、文件夹和去重行为等价

## 6. Tauri IPC 与前端数据边界

- [x] 6.1 将 `Opened` 改为持有 `Mutex<Catalog>` 与独立 `import_gate`，迁移现有列表、扩展名和导入索引编排且旧测试通过
- [x] 6.2 实现 `catalog_snapshot`、文件夹、标签、删除、还原和 purge 的 async commands，并注册到 `generate_handler!`
- [x] 6.3 在 `src/shared` 增加集中 IPC 包装和 DTO，先用 Tauri 官方 mock 锁定 command 名、参数、结果与错误传播

## 7. 素材工作区界面

- [x] 7.1 建立暖灰纸面、深墨导航与朱红强调的共享 CSS 变量、应用外壳、焦点样式和 reduced-motion 规则
- [x] 7.2 实现 `AssetWorkspace` 三段布局：文件夹/回收站侧栏、查询与标签栏、视口懒加载网格，并使用 `useDeferredValue` 处理文本查询
- [x] 7.3 实现文件夹创建、重命名、删除确认、层级显示与素材多文件夹编辑，明确提示删除文件夹不删除素材
- [x] 7.4 实现标签添加/移除、标签使用数量和多标签 AND 筛选，非法输入显示稳定错误码
- [x] 7.5 扩展单图预览的组织操作与删除入口，实现回收站列表、还原缺失文件夹警告及 purge 二次确认对话框
- [x] 7.6 在公开 `AssetWorkspace` seam 建立组件测试，覆盖查询、文件夹切换、标签编辑、删除/还原和取消/确认 purge
- [x] 7.7 验证键盘导航、语义标题、`aria-current`、对话框初始取消焦点、危险操作文案和空/错误状态

## 8. 性能、门禁与收尾

- [x] 8.1 记录 1,000 个受影响侧车的文件夹重命名 release 基线；超过 2 秒则在本变更内加入后台进度
- [x] 8.2 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、Clippy 与全部 Rust 测试并修正全部问题
- [x] 8.3 用 Windows release 构建和真实库走通文件夹、标签、组合搜索、删除、还原与二次确认清空流程
- [x] 8.4 执行双轴 `code-review`，分别核对仓库规范与本 change 的 specs/design
- [x] 8.5 运行 `openspec validate implement-asset-organization-and-trash --strict --no-interactive` 并修正全部问题
