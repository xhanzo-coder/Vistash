## 1. 可丢弃原型与信息架构门禁

- [x] 1.1 在生产目录外建立可丢弃原型与 10,000 条图片/长提示词纯数据 fixture，明确禁止复用原型代码
- [x] 1.2 原型紧凑顶栏、双库切换、可调整/折叠三栏与分库布局记忆
- [x] 1.3 原型图片原画幅瀑布流与详情列表，验证视图切换不丢选择/滚动
- [x] 1.4 原型提示词单封面卡片瀑布流、纯文本卡片与详情列表
- [x] 1.5 原型单击检查器、双击聚焦、多选/框选、批量工具条与共同/混合值
- [x] 1.6 原型两级搜索、普通关联、从库选图、本地导入后关联和封面选择完整流程
- [x] 1.7 对候选虚拟化依赖与小型自有定位器记录 WebView2/React 19/TypeScript 7 兼容、DOM 数、帧时间、内存、键盘与重排结果
- [x] 1.8 在 Windows 125%/150%/200% 缩放与宽/中/窄窗口验证焦点、抽屉、无水平滚动与键盘操作
- [x] 1.9 把虚拟化选型、精确断点、拒绝方案和实测门禁补回 `design.md`
- [x] 1.10 由产品所有者验收低保真原型与信息架构；未明确通过前不得开始任何生产代码任务

## 2. v2 库格式与可恢复迁移

- [x] 2.1 先为 `LibraryV2`、`AssetSidecarV1/V2`、`PromptAsset`、`PromptFolderList` 与迁移 journal 建立序列化/拒绝非法值测试
- [x] 2.2 实现稳定 Prompt ID、唯一非空正文、可选字段、纯文本备注、收藏、提示词文件夹/标签、有序图片哈希与封面不变量
- [x] 2.3 先建立 v1→v2 迁移成功、第 n 个侧车失败回滚、进程中断恢复、索引重建失败和版本最后提交测试
- [x] 2.4 实现独占迁移锁、持久 journal/备份树、图片侧车 v2 重写、Prompt 骨架建立与 `library.json` 最后原子提交
- [x] 2.5 实现迁移 typed `Channel` 进度与前端阻塞页，展示已处理数、总数、当前文件和稳定错误码

> 2.5 落地（2026-08-21）：新增稳定错误码 `library.format_too_old`，开库与启动恢复经
> `with_migration_signal` 把"待迁移的旧库"（含迁移未完成）从"元数据损坏"中区分出来，
> 并以测试钉住两者不得混淆；`LibraryStatus` 增加 `recorded_path`，恢复失败也报告原路径，
> 使前端能直接对它发起迁移。`migrate_library` 命令在 blocking worker 执行迁移，进度经
> typed `Channel` 呈现阶段/已处理数/总数/当前文件，索引重建闭包指向 `Index::rebuild_at`，
> 成功后接管为当前库并持久化设置。前端 `LibraryMigration` 阻塞页迁移期间禁用重入、呈现
> 进度与稳定错误码并允许失败后重试；`LibraryPicker` 遇到该错误码直接进入迁移页。进度
> 发送失败不中止迁移：完整性由独占锁、journal 与备份树保证，不依赖观察者存在。
- [x] 2.6 在 1,000 和 10,000 侧车 release fixture 记录迁移耗时、磁盘峰值、中断恢复耗时与回滚结果

> 2.6 落地（2026-08-21）：`migration.rs` 新增 release 专用基线测试
> `migration_release_baseline_on_thousand_and_ten_thousand_sidecars`
>（`#[cfg(not(debug_assertions))]` + `--ignored`），在 1,000 与 10,000 侧车真实 v1 fixture 上
> 各测三件事并经 eprintln 输出：完整迁移耗时与磁盘峰值（每 256 个进度事件采样一次库目录
> 字节数取峰值）；在 `SidecarsRewritten` 阶段模拟中断后用全新 `Migration` 续跑并断言
> `resumed=true`；在第 count/2 个侧车注入写入失败后断言 `library.json` 仍为 v1 且全部侧车
> 字节复原。实测（Windows，release）：1,000 侧车完整迁移 3.10 s、磁盘峰值约 1 MiB、
> 中断续跑 368 ms；10,000 侧车完整迁移 107.7 s（约 10.8 ms/侧车，符合设计"Windows 下可能
> 耗时数分钟"的预期）、磁盘峰值约 14 MiB、中断续跑 3.52 s；两档注入失败均回滚成功。
> 续跑远快于完整迁移，证明 journal 跳过已重写侧车生效。顺带修复：3.2/3.3 侧车改名后，
> 既有的 release 门控性能测试（`catalog/testing.rs` 的 `synthetic_sidecar`、`query.rs` 与
> `image_metadata.rs` 的基线测试）在 release 下已无法编译而 debug 四道门从不编译它们——
> 本次补齐 import 并删除改名遗留的未用引用，release lib test 目标重新可编译。

> 顺序调整（2026-08-21，经产品所有者确认）：2.5 与 2.6 移到第 3 章之后执行。理由是已验证的依赖，
> 而不是工作量偏好——迁移的最后一步要重建 v2 索引（设计第四条步骤 4），唯一实现 `Index::rebuild`
> 与 `Catalog` 的生产读取都仍用 v1 读取器 `AssetSidecar::read`，而迁移完成后侧车已是 v2；既有测试
> `a_v2_sidecar_is_refused_by_the_v1_reader_as_too_new` 证明它会以 `library.format_too_new` 拒绝。
> 因此在 3.1–3.3 把侧车读取器切到 v2 之前，`migrate_library` 端到端必然在重建那步失败并回滚，
> 2.6 也没有能走完的迁移可测。第 2 章其余任务已完成，这两条保持未勾选直到第 3 章落地。

## 3. Catalog 内部拆分与 SQLite v2 派生索引

- [x] 3.1 把现有单文件 `Catalog` 内部拆为图片元数据、提示词元数据、普通关联/封面、生命周期与派生查询模块，公开入口仍只暴露 `Catalog`

> 3.1 的落地范围：`catalog.rs`（2,188 行）拆为 `catalog/` 目录，`mod.rs` 只保留 `Catalog` 类型、构造、
> 索引访问与跨领域共用的原子写入，实现分入 `image_metadata.rs`、`lifecycle.rs`、`query.rs`，测试夹具进
> `testing.rs`。公开面零变化：公开类型仍由 `mod.rs` 重新导出，`src-tauri` 未改一行即通过编译；34 个测试
> 全部随各自代码就近迁移，拆分前后同为 202 通过 0 失败，clippy 干净。
> 提示词元数据与普通关联/封面两个模块本次未建立：它们目前没有任何内容（分别属于任务 4.x 与 6.x），
> 先建空模块只会留下一层没有内容的间接。边界规则已写入 `catalog/mod.rs` 模块文档，由 4.x/6.x 按同一
> 规则新增兄弟模块。
- [x] 3.2 先为 SQLite v2 prompts、prompt_folders、prompt_tags、prompt_images 与 images note/favorite 表列建立增量/重建快照等价测试
- [x] 3.3 实现 SQLite v2 schema、批量 prompt upsert、分类删除状态、共享标签分库计数与关联反查

> 3.2 先行建立 7 条等价/回归测试（TDD 红）：stub 返回显式 `Err` 时逐条失败，3.3 落地后同批转绿。
> 索引要有 note/favorite 列就必须读 v2 侧车，这连带要求整条生产路径切到 v2。已落地的切换是：
> `sidecar.rs` 把 v1 结构改名为 `AssetSidecarV1`（冻结、只服务迁移），`AssetSidecar` 改为
> `AssetSidecarV2` 的类型别名，于是索引、导入与编目共 50 处引用自动指向 v2，只有 `import.rs`
> 一处构造点需要补写 `note`/`favorite`；`Library` 改为持有 `LibraryMetaV2`，建库产出 v2
> `library.json`（含 `library_id`）并一并建立提示词骨架，使新建库与迁移产出的库结构完全一致；新增
> `prompt_path`/`prompt_trash_path`/`prompt_objects_dir`/`prompt_trash_dir`/`read_prompt_folders`/
> `write_prompt_folders`；迁移的 `commit` 改用 `LibraryMeta::read` 读那份仍在磁盘上的 v1 文件，其测试夹具
> 改为直接写 v1 JSON（生产侧已不存在 v1 写入器，这正是应有状态）。新增回归测试
> `a_freshly_created_library_is_already_v2_and_needs_no_migration` 钉住"新建库不得被判成需要迁移"。
>
> 3.3 的接口问题按预告解决：`Index::rebuild` 改为委托 `Index::rebuild_at(&Path)`，以库根路径为入口，
> 只依赖路径推导、两份文件夹清单与四棵目录树扫描，不需要库级元数据——迁移因此能在提交 v2
> `library.json` 之前重建索引（设计第四条"版本最后提交"），2.5 的解锁条件就此就位。

- [x] 3.4 删除并重建索引，验证两套空文件夹、图片 note/favorite、提示词全字段、两类回收站与普通关联/封面等价

> 3.4 落在 `catalog/query.rs`（2026-08-21）：`deleting_and_rebuilding_the_index_reproduces_the_full_v2_snapshot`
> 经生产入口 `Catalog::rebuild_index()`（内部先删旧索引文件再 `rebuild_at` 全量重建）比较整个
> `IndexSnapshot` 与增量索引逐字段相等，另以针对性断言钉住两类回收站状态、关联顺序、显式封面
> 与两套空文件夹。第 3 章至此完成。

## 4. 提示词素材、组织与当前值保存

- [x] 4.1 先建立提示词创建、非空正文验证、当前值原子覆盖、标题缺省与保存失败不改权威文件测试
- [x] 4.2 实现 `create_prompt`、`update_prompt`、按需详情读取与显式保存错误语义，确保编辑不创建历史版本

> 4.1/4.2 落在新建的 `catalog/prompt_metadata.rs`（2026-08-21）：按 3.1 确立的规则新增
> 提示词元数据兄弟模块，7 条测试先行（stub 返回显式 `Err` 时逐条红），实现后同批转绿。
> `create_prompt` 生成 UUIDv7 身份、正文是唯一必填项，归属校验（提示词文件夹必须在
> 清单中）先于任何文件写入；`PromptAsset::write_atomic` 本就先校验正文再触碰文件系统，
> 空白正文不会留下半个素材。`update_prompt` 只覆盖正文/标题/模型/参数四个主字段，
> 身份、组织、备注、收藏与关联保持不变，编辑就是覆盖同一份文件并以"目录内恰有一个
> .json"钉住不创建历史版本。保存失败语义用占住 `<id>.json.tmp` 的同名目录确定性注入：
> 失败后权威文件逐字段保持保存前内容。按需详情读取与"正常库中不存在"走新增稳定错误码
> `prompt.not_found`（与瞬时 IO 失败区分）；创建时归属未知提示词文件夹报新增码
> `prompt.folder_not_found`，两码已同步 `errorText.ts` 中文文案。
- [x] 4.3 先建立提示词文件夹创建/重命名/删除、多文件夹成员、根位置与中途写入回滚测试
- [x] 4.4 实现独立提示词文件夹树与批量 MetadataTransaction，确保同名图片/提示词路径不混合

> 4.3/4.4 落在 `catalog/prompt_metadata.rs`（2026-08-21）：6 条测试先行（stub 红）后实现
> 转绿。`create_prompt_folder`/`rename_prompt_folder`/`delete_prompt_folder` 与图片侧逻辑
> 平行但只读写 `prompt-folders.json`——测试以"两棵树各建同名根 `人物`、重命名提示词子树后
> 图片侧车与图片清单逐字节不动"钉住独立性。`set_prompt_folders` 覆盖多文件夹成员（集合
> 语义、排序去重）与空集即根位置。批量提交走提示词侧专用的 `PromptMetadataTransaction`
> （捕获提示词文件 + 清单原始字节，任一写入失败逆序回滚），中途注入失败后三份文件逐字节
> 复原；索引更新失败仍走全量重建兜底。新增错误码 `prompt.folder_exists`（含前端文案），
> 并把 `before_metadata_write`/`inject_metadata_failure_at` 上移到 `catalog/mod.rs` 供两个
> 领域模块共用；`Index` 新增 `list_prompts()`（只列正常库，回收站原文件夹由还原语义处理）。
- [x] 4.5 先建立共享标签词面、提示词标签幂等、分库计数、note 自动保存数据边界和 favorite 筛选测试
- [x] 4.6 实现提示词文件夹/标签、note/favorite 原子写入与派生索引维护

> 4.5/4.6 落在 `catalog/prompt_metadata.rs`（2026-08-21）：5 条测试先行（stub 红）后实现
> 转绿。`set_prompt_tags` 复用图片侧 `Tag` 词法（共享词面），排序去重保证幂等——重复设置
> 同一集合以"权威文件字节不变"钉住；分库计数经 `active_prompt_tag_counts` 与
> `active_tag_counts` 钉住互不混算。`set_prompt_note` 逐字保留换行与空格，且不推进
> `updated_at`、不改主字段（备注是独立自动保存流，否则边打字边保存会让更新时间失义）；
> `set_prompt_favorite` 是纯二值。三个 setter 与 `set_prompt_folders` 共用新的
> `load_editable_prompt` 助手，统一"正常库中不存在报 `prompt.not_found`、回收站状态拒绝
> 组织写入报 `prompt.write_failed`"的语义，全部先写权威文件再同步派生索引。
- [x] 4.7 建立 `PromptQuery` 公开测试，覆盖标题/正文 Unicode 子串、精确/根文件夹、多标签 AND、收藏、正常/回收站与稳定排序
- [x] 4.8 实现只加载命中轻量行的提示词查询与按需完整详情接口

> 4.7/4.8 落在 `index.rs` 与 `catalog/query.rs`（2026-08-21）：`Index::query_prompts` 在 SQL 侧
> 构建子句（位置、精确/根文件夹 `EXISTS`、多标签 AND `EXISTS`、收藏字面量），排序固定
> `created_at DESC, id DESC`（UUIDv7 身份兼作创建时间平局打破）；文本匹配不在 SQL 里做——
> `LIKE` 对中文无大小写语义且无法折叠，改为 Rust 侧 `to_lowercase().contains()` 对标题或
> 正文做子串命中。`Catalog::prompt_snapshot` 组装 `PromptSnapshot`（轻量行、提示词文件夹
> 清单、分库标签计数、回收站计数），回收站视图忽略文件夹范围（与图片侧同语义）；分库
> 计数复用 3.3 的 `active_prompt_tag_counts`。4 条测试与实现同批落地并全绿：Unicode 子串
> （CINEMATIC 大小写折叠、霓虹仅正文、逆光仅标题）、根+文件夹+多标签 AND、收藏与
> 正常/回收站位置（含回收站计数与回收站内精确文件夹）、稳定排序（created_at 相同按 id
> 降序）。按需完整详情即 4.2 已落地的 `prompt_detail`：列表只携带轻量行，正文/模型/参数
> 仅在检查器打开时读取单份权威文件。

## 5. 提示词回收站与生命周期

- [x] 5.1 先建立提示词删除、多原文件夹还原、部分/全部文件夹缺失、每个移动阶段失败回滚和图片不变测试
- [x] 5.2 实现提示词权威文件移入库内回收站、`PromptRestoreOutcome`、完整回滚与索引维护

> 5.1/5.2 落在新建的 `catalog/prompt_lifecycle.rs`（2026-08-21）：按 3.1 规则新增提示词
> 生命周期兄弟模块——与 `prompt_metadata` 分开是因为组织变更回滚文件内容而生命周期
> 移动文件本身；与图片侧 `lifecycle` 分开是因为提示词只有一份 JSON 权威文件，没有
> "本体 + 侧车"对。7 条测试先行（stub 返回显式 `Err` 时 6 条红，回滚测试因 stub 恒错
> 假绿、实现后才有约束力）。`delete_prompt` 只移动归属：正文/标题/标签/收藏/备注/关联
> 全部原样保留，仅文件夹移入 `deleted_from_folders`；对"正常库不存在"的删除先区分
> "已在回收站"（`prompt.trash_delete_failed`）与"哪里都找不到"（`prompt.not_found`）。
> `restore_prompt` 回到仍存在的原文件夹并经 `PromptRestoreOutcome.missing_folders`
> 说明缺失项，全部缺失时落根位置而不失败。两个阶段观察点（写入回收站/删除原件、
> 写入正常库/删除回收站件）逐阶段注入失败并以逐字节比较验证回滚。新增错误码
> `prompt.trash_delete_failed`/`prompt.trash_restore_failed`（含前端文案，分域理由与
> 事务类型相同：失败必须能归因到各自那棵树）；"删除提示词不改图片侧车与图片清单
> 一个字节"有专门测试钉住。
- [x] 5.3 先建立提示词 purge 成功、取消无写入、逐项失败隔离、普通关联清理与图片不变测试
- [x] 5.4 实现提示词回收站逐项 `PurgeReport`，永久删除只修改提示词文件与派生关联

> 5.3/5.4 落在 `catalog/prompt_lifecycle.rs`（2026-08-21）：3 条测试先行（stub 红）后实现
> 转绿。`purge_prompt_trash` 从索引取全部回收站轻量行逐项清理，单项失败不阻止其余条目，
> 失败项以 `PromptPurgeFailure { id, title, error }` 进报告（提示词以 ID 与可选标题标识，
> 没有哈希与原始文件名可报，故与图片侧 `PurgeFailure` 分型）。单文件两阶段删除与图片侧
> 同构：先改名 `.json.purge` 标记意图再真删，进程中断时残留标记让下次运行拒绝而不是
> 静默半删。普通关联是派生行：purge 只删提示词权威文件，`prompt_images` 子表随末尾的
> 索引重建从"文件已不存在"推导清除，测试以"重建后图片侧车逐字节不变 + 回收站计数归零"
> 钉住图片不变；"回收站为空时 purge 与取消在结果上不可区分"也有专门测试。新增错误码
> `prompt.trash_purge_failed`（含前端文案）。第 5 章至此完成。

## 6. 图片备注/收藏、普通关联与封面

- [x] 6.1 先建立图片 note 与 favorite 写入、重建、回收站排除与写入失败测试，再扩展图片查询和侧车

> 6.1 落在 `catalog/image_metadata.rs` 与 `index.rs`（2026-08-21）：5 条测试先行（setter
> stub 红）后实现转绿。`set_asset_note` 逐字保留换行与空格、不推进 `imported_at`、
> 不触碰组织与收藏；`set_asset_favorite` 纯二值。两者与既有 `set_asset_folders`/
> `set_asset_tags` 一并收敛到新的 `load_editable_sidecar` 助手，统一"回收站素材拒绝
> 组织写入、正常库中不存在也给出明确错误"的语义（此前对已删除素材的修改会退化成
> 指向缺失路径的 IO 错误，与提示词侧 `load_editable_prompt` 对齐后不再如此）。查询
> 扩展：`AssetQuery.favorite` 与 `Index::query_assets` 收藏字面量子句（与提示词侧同
> 语义），`AssetQueryInput` 加 `#[serde(default)]` 保持前端兼容；重建等价性由"写入
> 后重建索引仍带 note/favorite"钉住；写失败用占住 `<hash>.json.tmp` 的同名目录确定性
> 注入，失败后权威文件逐字节不变。v2 侧车在 3.3 已含 note/favorite 列，本任务无需
> 再改侧车结构。
- [x] 6.2 先建立图片—提示词多对多、重复关联幂等、两侧反查与解除不改素材测试
- [x] 6.3 实现 PromptAsset 单权威方的 link/unlink 与索引反查，禁止关联类型和双写图片侧车

> 6.2/6.3 落在新建的 `catalog/linking.rs`（2026-08-21）：按 mod.rs 既定规则为"普通
> 关联/封面"建立兄弟模块（封面回落由 6.6/6.7 在同模块继续）。4 条测试先行（stub 红）
> 后实现转绿。`link_images` 只追加新哈希到有序列表末尾（已有顺序属于使用者，默认
> 封面取第一张，不得重排），重复关联以"权威文件字节不变"钉住幂等；目标哈希必须真实
> 入库（含回收站——关联到回收站图是合法呈现状态，指向从未入库的引用才是错误），未知
> 哈希报新增码 `prompt.linked_image_not_found`（含前端文案）。`unlink_image` 对未关联
> 哈希是幂等空操作；解除显式封面时封面清空回落缺省，维持"封面必须在关联列表中"
> 不变量。反查走新增 `Index::prompts_for_image`（JOIN prompt_images，含回收站提示词，
> 轻量行）；`Index::asset_exists` 服务存在性校验。测试钉住：多对多两个方向、解除后
> 图片侧车逐字节不变、反查随解除清空。无关联类型、无双写图片侧车——结构上不可能：
> 图片侧 API 根本没有反向列表入口。顺带把 `load_editable_prompt` 上移到 `catalog/
> mod.rs` 并补"在回收站"识别（此前对已删除提示词的组织写入会误报 not_found），与
> 6.1 的 `load_editable_sidecar` 同语义。
- [ ] 6.4 先建立两类回收站关联可见、还原恢复、提示词 purge 不写图片与图片 purge 批量清理关联失败时保留图片对测试
- [ ] 6.5 把图片 purge 与提示词关联/封面清理纳入 Catalog 事务边界，保证无悬空关联
- [ ] 6.6 先建立默认封面、指定封面、解除/图片 purge 后顺序回落与无图纯文本状态测试
- [ ] 6.7 实现 cover 不变量和轻量卡片 DTO，不复制任何图片字节
- [ ] 6.8 建立“从图片库选择”与“本地导入后关联”公开测试，覆盖重复图片、入库成功但关联失败和逐项结果
- [ ] 6.9 实现复用现有导入不变量的 import-and-link 编排，已入库图片不产生第二份本体

## 7. 批量操作、全局搜索与 Tauri IPC

- [ ] 7.1 定义并测试统一 `BatchReport`、图片/提示词批量 ID 验证、逐项失败隔离与进度观察点
- [ ] 7.2 实现图片/提示词批量文件夹、共享标签、收藏、普通关联和移入回收站，禁止批量覆盖正文/备注
- [ ] 7.3 建立轻量分组全局搜索测试，覆盖图片文件名/标签、提示词标题/正文/标签、分组数量与类型定位
- [ ] 7.4 实现 `global_search`、`image_snapshot`、`prompt_snapshot` 与按需检查器详情，禁止全局搜索加载原图/色卡/全部关联
- [ ] 7.5 先用 Tauri 官方 mock 锁定提示词 CRUD/回收站、note/favorite、普通关联/封面、批量报告、全局搜索与布局偏好 IPC 名称/参数/错误传播
- [ ] 7.6 实现 async Tauri commands，文件扫描/批量处理/迁移继续在 blocking worker，并在独立 Catalog 锁边界内串行权威变更

## 8. 生产工作台外壳与共享交互模型

- [ ] 8.1 从已验收原型提取信息架构而非代码，建立紧凑顶栏、双库切换、左分类、中央集合和右检查器外壳
- [ ] 8.2 建立无最终品牌色值的语义表面/文本/边界/强调/选中/焦点/危险/间距/阴影/动效 token，以浅色占位值达到对比度门禁
- [ ] 8.3 建立分库布局/视图/文件夹/筛选/滚动偏好模型，以 `library_id` 持久化并验证库路径移动后仍能恢复
- [ ] 8.4 先为统一 `SelectionModel` reducer 建立单击、Ctrl/Shift、框选、Ctrl+A、活动项、范围锚点、Esc 与跨视图保留测试
- [ ] 8.5 实现可被图片与提示词视图复用的选择 Context、批量工具条、共同/混合检查器摘要与键盘焦点语法
- [ ] 8.6 实现中等/窄窗口左栏折叠与右检查器抽屉，删除固定 960px 最小宽并保证焦点不被粘性层遮挡

## 9. 图片工作台

- [ ] 9.1 实现虚拟化原画幅瀑布流，只渲染视口/过扫项并保留密度、多选、焦点和滚动恢复
- [ ] 9.2 实现虚拟化图片详情列表、可排序信息列、备注摘要与瀑布流视图等价切换
- [ ] 9.3 实现图片检查器信息/色卡、组织、备注、关联提示词分区和双击/Enter 聚焦原图模式
- [ ] 9.4 实现图片 note 延迟/失焦/`Ctrl+Enter` 自动保存状态机、favorite 快捷操作与保存失败草稿保留
- [ ] 9.5 实现图片回收站、还原缺失文件夹警告、逐项 purge 结果与取消默认焦点二次确认

## 10. 提示词工作台与普通关联

- [ ] 10.1 实现虚拟化提示词卡片瀑布流，覆盖单封面/+N、纯文本卡片、标题缺省、复制与收藏
- [ ] 10.2 实现虚拟化提示词详情列表、文本摘要、组织/关联列与视图等价切换
- [ ] 10.3 实现提示词检查器当前正文、标题/模型/参数、组织、备注、关联图片与长文本聚焦编辑器
- [ ] 10.4 实现提示词主要字段显式保存/`Ctrl+S`、取消、未保存导航拦截、保存失败草稿保留与备注独立自动保存
- [ ] 10.5 实现关联图片库内多选器、本地拖入/选择导入、解除、已删除状态、设为封面与封面回落
- [ ] 10.6 实现提示词回收站、还原缺失文件夹警告、二次确认 purge 与图片不变呈现

## 11. 搜索、可访问性、性能与收尾

- [ ] 11.1 实现 `Ctrl+K` 全局搜索面板、图片/提示词分组计数、类型定位与 `Ctrl+F` 分库搜索/可移除条件
- [ ] 11.2 在公开 Workspace/Inspector seam 建立组件测试，覆盖双库布局恢复、四视图、单/多选、批量操作、草稿、关联、搜索、两类回收站与错误码
- [ ] 11.3 完成 ARIA grid/listbox 键盘模式、roving focus、方向键/Home/End、焦点圈、对话框焦点陷阱/Esc/触发器归还与高对比/缩放验收
- [ ] 11.4 记录 10,000 图片瀑布流、10,000 图片列表、10,000 长提示词卡片/列表的 DOM 峰值、首屏、快速滚动、内存与视图切换 release 基线
- [ ] 11.5 在 E 盘临时库复制走通 v1→v2 迁移、两库组织、备注/收藏、多选、关联、封面、搜索、删除/还原/purge 的 Windows release 流程
- [ ] 11.6 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、Clippy 与全部 Rust 测试，并修正全部问题
- [ ] 11.7 使用 `web-design-guidelines` 审查信息层级、焦点、窗口适配、文本溢出、异步状态、虚拟化和语义主题结构
- [ ] 11.8 执行双轴 `code-review`，分别核对仓库规范与本 change 的 specs/design，消解全部发现
- [ ] 11.9 运行 `openspec validate design-dual-asset-workspace --strict --no-interactive` 并修正全部问题
