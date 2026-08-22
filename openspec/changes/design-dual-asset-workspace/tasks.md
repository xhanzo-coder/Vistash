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
- [x] 6.4 先建立两类回收站关联可见、还原恢复、提示词 purge 不写图片与图片 purge 批量清理关联失败时保留图片对测试
- [x] 6.5 把图片 purge 与提示词关联/封面清理纳入 Catalog 事务边界，保证无悬空关联

> 6.4/6.5 落在 `catalog/linking.rs` 与 `catalog/lifecycle.rs`（2026-08-21）：3 条测试
> 先行——两条钉住既有正确行为当场绿（图片进回收站不改提示词文件、反查含两类回收站
> 素材、双向还原后无需修复步骤；提示词 purge 后图片本体/侧车与其他提示词逐字节不变、
> 派生反查随重建清除），新行为测试红在"purge 未清理关联"。实现按设计第三条：图片
> purge 在任何文件暂存之前调用 `remove_linked_image_everywhere`——先经反查把所有受影响
> 提示词（正常 + 回收站）读入内存算出修改后内容（读取/解析失败发生在第一个字节落盘
> 之前；文件已不存在的过期行跳过，交给末尾索引重建自愈），再逐个写盘，任一失败逆序
> 恢复原字节并让这张图的 purge 整体失败、图片对保持完整。显式封面指向被 purge 的图时
> 清空回落缺省，与解除关联同语义；回收站提示词里的悬空引用同样被清理。注入观察点复用
> `before_metadata_write` 计数器，第 0/1 个写入各注入一次分别覆盖"未触碰"与"逆序回滚"
> 路径。实现中发现并修正一个真实缺陷：`before_metadata_write()?` 的 `?` 会绕过回滚块，
> 注入失败因此留下半清理状态——把观察点与真实写入合并为同一个可失败步骤后回滚路径
> 唯一。
- [x] 6.6 先建立默认封面、指定封面、解除/图片 purge 后顺序回落与无图纯文本状态测试
- [x] 6.7 实现 cover 不变量和轻量卡片 DTO，不复制任何图片字节

> 6.6/6.7 落在 `catalog/linking.rs` 与 `index.rs`（2026-08-21）：3 条 Catalog 测试先行
> （`set_prompt_cover` stub 红）后实现转绿。新增 `set_prompt_cover(id, Option<&hash>)`：
> `Some` 只接受已关联的图片（不变量"封面必须在关联列表中"本就由 `PromptAsset::write_
> atomic` 校验层强制，复用既有码 `prompt.cover_not_linked` 与前端文案，未入库与已入库
> 但未关联统一为同一失败语义——正确的引导都是先建立关联）；`None` 清除显式值回到缺省；
> 重复设置同一状态是字节级幂等空操作。回落规则收敛为单一权威：`PromptRow::resolved_
> cover()` 显式值优先、缺省取第一张关联、无关联即纯文本卡片（None），瀑布流/列表/
> 检查器都从这里取；轻量卡片 DTO 即既有 `PromptRow`（只携带哈希引用，从不复制图片
> 字节），解析规则配 1 条单元测试钉住。测试覆盖：三张图的缺省/显式/清除/解除回落全
> 序（显式封面不受其他解除影响）、purge 封面图后有效封面按顺序回落到第一张剩余关联、
> 纯文本卡片拒绝设封面。第 6 章至此完成。
- [x] 6.8 建立“从图片库选择”与“本地导入后关联”公开测试，覆盖重复图片、入库成功但关联失败和逐项结果
- [x] 6.9 实现复用现有导入不变量的 import-and-link 编排，已入库图片不产生第二份本体

> 6.8/6.9 落在 `catalog/linking.rs`（2026-08-21）：3 条公开测试先行（`import_and_link`
> stub 红）后实现转绿。编排入口 `Catalog::import_and_link(prompt_id, sources)` 先确认
> 提示词可编辑（提示词不可用时不导入任何文件），再逐源处理：先算哈希，内容已在库中
> （正常库或回收站）直接复用单份本体报 `LinkedExisting`——"从库选图"与重复拖入同一张
> 图都不会产生第二份本体（以 objects 目录文件计数钉住）；否则走既有 `import_one` 完整
> 导入不变量（校验、回滚、缩略图）+ `index_imported` 后报 `LinkedImported`。逐项结果
> `ImportAndLinkReport/Item/Outcome`：坏文件逐项报 `ImportFailed`（含稳定错误码与原始
> 文件名），入库成功但关联写入失败时报 `ImportedButNotLinked` 且图片保留在库里、绝不
> 出现在关联列表、绝不冒充已关联；只有索引这类环境级故障才以 `Err` 传播。为给"关联
> 写入失败"提供确定性注入点，`link_images` 补上权威写入前的统一观察点
> `before_metadata_write`（生产路径无行为变化）。第 6 章至此完成。

## 7. 批量操作、全局搜索与 Tauri IPC

- [x] 7.1 定义并测试统一 `BatchReport`、图片/提示词批量 ID 验证、逐项失败隔离与进度观察点
- [x] 7.2 实现图片/提示词批量文件夹、共享标签、收藏、普通关联和移入回收站，禁止批量覆盖正文/备注

> 7.1/7.2 落在新建的 `catalog/batch.rs`（2026-08-21）：6 条测试先行后实现转绿。
> 统一报告 `BatchReport { succeeded, failures[{id, display_name, error}] }`——部分成功
> 是常态所以不是 `Result`；核心循环 `run_batch` 逐项执行"完整单项权威写入 + 索引更新"，
> 一项失败只记入该目标、绝不回滚先前成功项（以注入第二个关联写入失败、断言一三仍在
> 关联列表钉住），每处理完一项（含失败项）调用一次 `BatchProgress::on_progress(done,
> total)`（`RecordingProgress` 断言精确序列）。目标构造阶段读派生索引取当前值与显示名
> （图片=原始文件名、提示词=标题否则正文首行，仅失败时可见），ID 验证失败（未知哈希/
> 未知提示词 ID）与执行阶段失败走同一失败通道，显示名缺省回落 ID 字面值。13 个公开
> 方法覆盖两侧的文件夹/标签增删、收藏二值、普通关联与移入回收站；已处于请求状态的
> 目标计成功但不触碰权威文件（以侧车字节逐字节不变钉住批量幂等）。新集合仍经既有
> 单项 setter 写入，回收站拒绝（`library.asset_metadata_write_failed`/`prompt.write_
> failed`）与索引兜底全部复用原路径。禁止批量覆盖正文/备注由 API 面本身满足：批量
> 模块没有任何接收正文或备注参数的入口。落地中确认一个既有事实：单项 setter 走直接
> `write_atomic`，元数据写入观察点只在 `link_images` 与文件夹树事务上，回滚测试因此
> 选 `batch_link_to_prompt` 作为注入载体。
- [x] 7.3 建立轻量分组全局搜索测试，覆盖图片文件名/标签、提示词标题/正文/标签、分组数量与类型定位
- [x] 7.4 实现 `global_search`、`image_snapshot`、`prompt_snapshot` 与按需检查器详情，禁止全局搜索加载原图/色卡/全部关联

> 7.3/7.4 落在 `catalog/query.rs`（2026-08-21）：4 条测试与实现同批落地（纯派生查询，
> 沿用 4.7/4.8 先例）并全绿。`global_search(text)` 返回 `GlobalSearchResult { assets,
> prompts }`——分组本身就是类型定位，各组数量即组长度，结构上不可能混出无类型瀑布流；
> 只搜正常库（两类回收站都不进入快速跳转范围，有专门测试钉住），空白文本返回空结果
> 而不是全部素材。文本语义与各自视图一致：Rust 侧大小写折叠子串匹配，图片命中文件名
> 或标签、提示词命中标题/正文/标签，排序直接复用两个视图查询的稳定顺序。禁止加载
> 原图/色卡/全部关联由返回类型满足：结果只含派生索引轻量行，不触碰 objects 目录也
> 不展开关联。按需检查器详情补齐图片侧 `image_detail(hash)`（轻量行 + 关联提示词反查，
> 反查含回收站提示词以如实体现已删除状态；未知哈希报 `library.not_found`），原图字节
> 继续走既有 `read_asset_body` 单独请求；提示词侧 `prompt_detail` 与两个 snapshot 均
> 为既有入口，本次未改语义。
- [x] 7.5 先用 Tauri 官方 mock 锁定提示词 CRUD/回收站、note/favorite、普通关联/封面、批量报告、全局搜索与布局偏好 IPC 名称/参数/错误传播
- [x] 7.6 实现 async Tauri commands，文件扫描/批量处理/迁移继续在 blocking worker，并在独立 Catalog 锁边界内串行权威变更

> 7.5/7.6 落在 `src-tauri/src/commands.rs` 与 `src/shared/ipc.ts|test.ts`（2026-08-21）：
> 前端先用 Tauri 官方 `mockIPC` 建立 7 条契约测试，钉死全部新命令名与参数形状——
> 提示词 CRUD/回收站/组织（create_prompt…purge_prompt_trash）、普通关联/封面/
> 导入后关联（link_images/unlink_image/set_prompt_cover/import_and_link/image_detail）、
> 图片 note/favorite、批量报告（Channel 进度逐项转交 + BatchReport 形状）、global_search
> 与布局偏好（read_layout/write_layout 以 libraryId 为键）；错误传播沿用既有 IpcError
> 收敛测试。顺带补齐两处 DTO 镜像缺口：AssetRow 的 note/favorite 与两类查询的
> favorite 字段此前未同步进 TS 类型。Rust 侧新增约 35 个 async command：参数先经
> ContentHash/PromptId/FolderPath/Tag/LibraryId 校验再进 `with_catalog`（spawn_blocking +
> 独立 Catalog 锁内串行权威变更）；13 个批量命令经新的 `ChannelProgress` 适配器实现
> 核心 `BatchProgress` trait，通道断开只记标记不把已部分成功的批量变成错误；文件扫描/
> 批量处理/迁移继续留在 blocking worker。布局偏好落在核心新增的 `LayoutStore`
> （settings.rs）：以库 ID 而不是库路径为键存放在应用配置目录，内容是前端领域的任意
> JSON 透传，4 条单元测试覆盖从未保存返回 None、任意 JSON 往返覆盖、分库不互串与
> 损坏报告不静默重置。全部 51 个命令已注册进 `generate_handler!`；四道门禁通过
> （前端 17 测试、Rust 281 测试、clippy -D warnings 干净）。

## 8. 生产工作台外壳与共享交互模型

- [x] 8.1 从已验收原型提取信息架构而非代码，建立紧凑顶栏、双库切换、左分类、中央集合和右检查器外壳
- [x] 8.2 建立无最终品牌色值的语义表面/文本/边界/强调/选中/焦点/危险/间距/阴影/动效 token，以浅色占位值达到对比度门禁

> 8.1/8.2 落在 `src/features/workspace/` 与 `styles.css`（2026-08-21）：新组件
> `WorkspaceTopBar` 只提取已验收原型"A — 平衡工作台"的信息架构——品牌 h1、素材/
> 提示词库并列一级入口（同一 `nav[aria-label="主导航"]` 地标内以 aria-current 区分）
> 与始终可见的库路径同处一行，未复制原型任何代码；`App.tsx` 删除本地 Section 类型与
> 旧的大顶栏/主导航标记改为消费该组件。三栏外壳的左分类（既有 catalog-rail）与中央
> 集合保持原位，右检查器槽位按既定决策推迟到第 9 章 SelectionContext 落地时随
> AssetWorkspace 重建一并成形，避免对尚不存在的内部先造投机 API。`styles.css` 整体
> 迁移到语义 token：`:root` 成为全文件唯一允许裸颜色的位置，覆盖表面九级、两级深栏
> 文本、边界四档、强调/选中/双焦点环/五档危险/进行中状态，以及间距、字号、字体、
> 圆角、阴影与动效刻度——取值全部是浅色**占位**主题，最终品牌色留给后续视觉设计
> 阶段。占位值经 WCAG 计算选定并写入机器门禁 `designTokens.test.ts`（7 条）：必需
> token 清单、`:root` 之外零裸颜色、正文 4.5:1、强调面文字 4.5:1、深栏文本 4.5:1、
> 焦点环与非文本边界 3:1、`prefers-reduced-motion: reduce` 下动效时长归零（组件因此
> 只需一份过渡规则）。测试读取仓库原文用 node:fs，为此补上标准开发依赖
> `@types/node`；曾尝试 Vite `?raw` 导入但整套运行时会被 vitest 的 CSS 桩替换成空串，
> 已弃用。旧 `.eyebrow` 标签仍被素材空状态使用，补回语义化规则（小字号按 4.5:1 取
> 强调深色）。固定 960px 最小宽按任务边界保留，8.6 折叠抽屉落地时删除。四道门禁通过
> （前端 lint/typecheck/27 测试、Rust 全部目标零失败、clippy -D warnings 干净）。
- [x] 8.3 建立分库布局/视图/文件夹/筛选/滚动偏好模型，以 `library_id` 持久化并验证库路径移动后仍能恢复

> 8.3 落在 `commands.rs`、`src/shared/types.ts` 与新建的
> `src/features/workspace/libraryLayout.ts|test.tsx`（2026-08-21）。`LibraryStatus`
> 新增 `library_id`（取自打开库 v2 元数据的稳定 ID），使前端拿得到持久化键——预期值
> 在 Rust 测试里从磁盘权威 `library.json` 独立读回而非同一内存对象自证，未开库时
> 断言无 ID 可报。前端模型：`normalizeLayout` 把后端透传的任意 JSON 逐字段安全合并
> 到默认值上（视图/文件夹/标签/收藏/滚动偏移，坏字段各自回退不拖垮整份），形状校验
> 因此完全属于前端领域；`useLibraryLayout(libraryId)` 完成按库读取、更新与防抖写回。
> 关键语义各有测试钉住：切库时旧库待写先落盘且新库读不到他库偏好；**库目录移动后同
> 一 library_id 仍恢复布局**（mock 仓库只认 ID，"路径不参与键"即恢复语义的结构本身）；
> 读失败呈现 problem 且停在默认值、写失败呈现 problem 而界面状态照常生效——损坏绝不
> 静默重置，也绝不阻塞工作台；读取期间已有本地调整时不被磁盘旧值覆盖；未选库时零
> IPC。React 实现遵守项目 lint 的两条硬规则：effect 内不同步 setState（快照记录自己
> 的库 ID，渲染期派生回默认值）、渲染期不读写 ref（合并基底只在 effect 与事件里维护）。
> 消费方接入随第 9 章 AssetWorkspace 重建进行，本任务交付的是带完整合同测试的接缝。
> 四道门禁通过（前端 lint/typecheck/35 测试、Rust 282 测试零失败、clippy -D warnings
> 干净）。
- [x] 8.4 先为统一 `SelectionModel` reducer 建立单击、Ctrl/Shift、框选、Ctrl+A、活动项、范围锚点、Esc 与跨视图保留测试
- [x] 8.5 实现可被图片与提示词视图复用的选择 Context、批量工具条、共同/混合检查器摘要与键盘焦点语法

> 8.4/8.5 落在 `src/features/workspace/selection.ts|test.ts` 与新建的
> `selectionContext.tsx|test.tsx`、`batchToolbar.tsx|test.tsx`、`inspectorSummary.ts|test.ts`
> （2026-08-21）。状态机是纯 reducer（不触碰 React 与 IPC），保存五类事实：查询有序 ID、
> 活动 ID、选中集合、范围锚点与聚焦 ID；13 条合同测试逐条钉住任务列举的交互——单击替换、
> Ctrl/Cmd 并入与移出（活动/锚点跟随被点项）、Shift 范围（锚点不动、无锚点退化为单击）、
> 框选默认替换/additive 并入且不碰键盘状态、Ctrl+A 不动活动与锚点、Esc 只清选中保留活动
> 与聚焦、方向键/Home/End 移动活动项（Shift 从固定锚点生长或收缩范围）、空域上任何动作
> 都安全，以及跨视图保留三态：同一查询域原样返回、缩域取交集并清空越界字段、扩域不影响
> 既有选中。8.5 在其上建立 `SelectionProvider`/`useSelection`：useReducer + 局部 Context
> （决策第七条，不用全局状态库），把修饰键单击翻译成动作、把键盘语法挂到 `handleKeyDown`
> （返回是否已处理供视图决定 preventDefault，打字焦点在 input/textarea/contentEditable
> 内时不劫持）；查询域变化经 effect 下发 `idsReplaced`，同一批 ID 由快速路径原样返回。
> `BatchToolbar` 是纯外壳：计数文案、全选/清除与 children 插槽（第 9/10 章注入视图专属
> 批量动作），count 为 0 不渲染，样式全部走语义 token 并把粘性层级提升为 `--z-sticky`。
> `summarizeCommon` 计算多选检查器的共同/混合摘要：完全一致报 common；多值字段有分歧报
> mixed 但仍携带共同子集（UI 呈现「人像（混合）」）；收藏二值不一致报 mixed。四道门禁通过
> （前端 lint/typecheck/59 测试、Rust 282 测试零失败、clippy -D warnings 干净）。
- [x] 8.6 实现中等/窄窗口左栏折叠与右检查器抽屉，删除固定 960px 最小宽并保证焦点不被粘性层遮挡

> 8.6 落在新建的 `src/features/workspace/breakpoints.ts|test.tsx` 与
> `workspaceDrawer.tsx|test.tsx`、`AssetWorkspace.tsx|test.tsx` 接线与 `styles.css`
> （2026-08-21）。断点按设计第 116 行以 CSS px 视口宽度确定：`useWindowTier` 返回
> wide/medium/narrow 三档（>1080 / ≤1080 / ≤720），经 matchMedia change 监听驱动，
> 不按物理像素或系统缩放另建分支；断点数值与 styles.css 媒体查询的一致性由测试读取
> 样式表原文钉住，改一处不改另一处会当场失败。抽屉机制两侧共用：`WorkspaceDrawer`
> 在宽屏 inline 模式原位渲染内容，中等/窄窗口 drawer 模式呈现覆盖面板——打开时焦点
> 移入面板、Esc 与点击背景请求关闭、关闭后焦点归还给打开前的元素；左分类栏是第一个
> 消费方（side="start"，边缘入口按钮带 aria-expanded/aria-controls），右检查器在第 9
> 章以 side="end" 接入同一组件，避免对尚不存在的检查器内容先造投机 API（与 8.1 的
> 处理一致）。窄屏自动收起不写任何宽屏宽度偏好。AssetWorkspace 组件测试新增"中等
> 窗口左栏收起为抽屉、边缘入口打开且 Esc 关闭"一条，既有测试显式设定宽屏视口；
> jsdom 缺失的 matchMedia 由新增的全局测试 setup 补桩。styles.css 删除固定 960px
> 最小宽，旧的 1100px 块替换为 720px 压缩块（顶栏与详情列），z-index 收敛为
> sticky/drawer/dialog/skip 四档 token；键盘焦点遮挡问题以 `html` 的
> scroll-padding-block-end 为粘性批量工具条预留高度解决，方向键滚动定位时聚焦项
> 不会被贴底工具条盖住（虚拟化滚动容器的同类预留随第 9 章接入）。四道门禁通过
> （前端 lint/typecheck/67 测试、Rust 282 测试零失败、clippy -D warnings 干净）。
> 第 8 章至此完成。

## 9. 图片工作台

- [x] 9.1 实现虚拟化原画幅瀑布流，只渲染视口/过扫项并保留密度、多选、焦点和滚动恢复
  - 2026-08-21 落地：`waterfallMetrics.ts` 纯几何（列数=容器宽/期望瓦片宽，瓦片高按编目画幅换算，非法画幅回退正方形）；`AssetWaterfall.tsx` 用锁定的 @tanstack/react-virtual@3.14.10（lanes 多列窗口化、getItemKey=hash、overscan 6），位置与可见项归 TanStack，选择/键盘/框选语义全部走统一 SelectionModel；点击显式聚焦卡片（Safari 不产生原生按钮聚焦，键盘巡游依赖它）；滚动偏移经分库布局偏好 `scrollOffsets["assets-waterfall"]` 恢复与防抖持久化，恢复每个滚动键只执行一次；双击暂接旧详情页（9.3 替换为聚焦原图）。测试：万条查询 DOM ≤80 项且深处滚动保持有界、恢复/上报、单击/Ctrl/Shift/双击、方向键巡游+Ctrl+A。旧 AssetGrid 删除，空态迁至 AssetWorkspace。
- [x] 9.2 实现虚拟化图片详情列表、可排序信息列、备注摘要与瀑布流视图等价切换
  - 2026-08-22 落地：`AssetDetailList` 单车道虚拟化（固定行高 56px），八列按规格齐备（缩略图/文件名/文件夹/标签/尺寸/格式/导入时间/备注摘要）；文件名、尺寸（面积并列回退宽度）、格式、导入时间四列可排序并带 aria-sort 与方向箭头，多值列不排序；`assetSort.ts` 客户端稳定排序（不改输入数组，穷尽 switch 保护）；`noteSummary.ts` 取首个非空行折叠空白截断加省略号。两视图挂在同一个 SelectionProvider 上，视图切换经 `layout.view` 持久化且查询不重发、选择与活动项保留（集成测试断言 IPC 次数不变）；滚动偏移独立记在 `scrollOffsets["assets-list"]`。共享行为抽为 `useScrollRestore`/`useRovingFocus` 钩子，瀑布流同步重构复用。
- [x] 9.3 实现图片检查器信息/色卡、组织、备注、关联提示词分区和双击/Enter 聚焦原图模式
  - 2026-08-22 落地：两个视图的 onKeyDown 先交给统一 SelectionModel 键盘语法，剩余 Enter 且存在活动项时才触发 `onOpenFocused`——聚焦原图只能双击或 Enter 显式进入（jsdom 的 dblclick 不派发前置 click，测试期望值按此固定）。`AssetInspector` 经 SelectionModel 解析活动项与多选：单件呈现四个可定位分区（`data-inspector-section` info/organization/note/links），多选只呈现数量摘要；信息/色卡分区取自编目元数据（色卡失败走 ErrorLine 稳定码），组织分区的文件夹勾选/标签增删回调进 runMutation+快照刷新，回收站位置以"还原素材"替代组织编辑并隐藏删除按钮，备注分区只读并显式标注编辑随 9.4 接入。`AssetPromptLinks` 以 hash 为 key 重挂载自取 image_detail：已关联列表对回收站提示词显式标记"已删除"不隐藏，解除经 unlink_image 后刷新，建立经 prompt_snapshot（活动区）候选多选逐条 link_images（后端幂等），已关联候选不再出现在选择器。SelectionProvider 上移包住中央区+右检查器（宽屏 `.with-inspector` 第三列原位，中窄窗口 side="end" 抽屉+查询条边缘入口），单击只更新检查器不替换集合视图；旧 AssetDetails 删除，删除/还原动作迁入检查器，AssetPreview 复用为聚焦模式（退出按钮改"退出聚焦"，聚焦目标被权威刷新移除时自动退回集合视图）。
- [x] 9.4 实现图片 note 延迟/失焦/`Ctrl+Enter` 自动保存状态机、favorite 快捷操作与保存失败草稿保留
  - 2026-08-22 落地：`AssetNoteEditor` 以 hash 为 key 重挂载，写入路径只读 ref（防抖回调/失焦/Ctrl+Enter 三入口共用），停止输入 800ms 自动保存；失败时草稿原样留在编辑框并经 ErrorLine 呈现 `library.asset_metadata_write_failed` 稳定码，dirty 不清除——再次修改、移出焦点或 Ctrl+Enter 都会重试；保存在途又输入时保持编辑态并重新排队；卸载时仍有未落盘草稿则尽力补写一次。检查器信息分区头部加二值收藏开关（aria-pressed，不扩展为评级），查询条加"只看收藏"筛选按钮驱动 query.favorite，中央视图随之只返回收藏的正常图片。状态区 role="status" aria-live 呈现 未保存/正在保存…/已保存。
- [x] 9.5 实现图片回收站、还原缺失文件夹警告、逐项 purge 结果与取消默认焦点二次确认
  - 2026-08-22 落地：四项能力的主体在第 5 章（库内回收站）已建成，并在 9.x 工作台重接中保持可用——左栏回收站入口切 `location=trash` 查询、回收站工具条"清空回收站"带二次确认（ConfirmDialog 挂载即聚焦取消，集成测试断言 activeElement）；purge 报告区呈现"已永久删除 N 个，失败 M 个"，失败项逐条列文件名 + ErrorLine 稳定错误码；还原经检查器（9.3 迁入）触发，`missing_folders` 非空时以 `trash.restore_target_folder_missing` 警告呈现且不阻断还原。本任务增量：新增"清空回收站后呈现逐项结果"集成测试，把 mock purge 改为带失败项（滞留文件.png + library.asset_metadata_write_failed），断言成功计数、失败计数、文件名与错误码并存——此前该报告 UI 无任何测试覆盖。

## 10. 提示词工作台与普通关联

- [x] 10.1 实现虚拟化提示词卡片瀑布流，覆盖单封面/+N、纯文本卡片、标题缺省、复制与收藏
  - 2026-08-22 落地：新建 `features/prompts/`——`PromptCardWaterfall` 复用图片侧同构的 lanes 窗口化（waterfallMetrics + useScrollRestore + useRovingFocus + SelectionModel），卡片身份是提示词而非关联图片；有图卡片只渲染一张封面（显式 cover_image_hash，缺省回落第一张关联）加 `+N` 计数徽章，无图卡片是纯文本卡片且不渲染任何占位 img；标题缺省统一走 `promptDisplay.ts` 的 `promptDisplayTitle`（显式标题优先，否则正文首个非空行），供后续列表与搜索共用；复制经 `navigator.clipboard.writeText` 写完整当前正文，成功给"已复制"状态、失败给 role=alert 出路提示；收藏为卡片角部 aria-pressed 开关，经 `onToggleFavorite` 上报工作区。卡片高度由 `promptCardMetrics.ts` 纯估算（封面 3:2 + 正文截断 4 行），styles.css 的 line-clamp/行高与常量一一对应并有注释互指；复制/收藏是叠放芯片而非嵌套 button。附带把 Thumbnail 的懒加载生命周期抽成 `workspace/thumbnailUrl.ts` 供封面复用（Thumbnail 行为不变）。测试 14 项：窗口化万级上限、纯文本卡片无占位图、封面+4 计数、标题缺省/显式优先、剪贴板成功与拒绝、收藏上报、单击/Ctrl 选择；设计 token 守卫测试拦下徽章裸颜色后改用 `--surface-backdrop`/`--text-on-accent`。
- [x] 10.2 实现虚拟化提示词详情列表、文本摘要、组织/关联列与视图等价切换
  - 2026-08-22 落地：新建 `PromptDetailList`——单车道窗口化（与图片侧同构），七列对齐规格：标题/正文摘要（首格双行，标题行用 promptDisplayTitle、摘要行复用 noteSummary 取正文首行截断）、提示词文件夹、共享标签、关联图片数、模型/平台（缺省显式"—"）、收藏（★ 已收藏/☆ 未收藏）、更新时间；可排序列为标题/模型/更新时间，多值列与派生列不排序，`promptSort.ts` 纯模块与图片侧 sortAssets 同构（zh 拼音序、缺省模型成组、稳定不修改输入）。表头与行复用图片侧通用 detail-* 类，仅在 `.prompt-detail-list` 下替换栅格列。视图等价以测试证明：卡片瀑布流与详情列表挂同一 SelectionProvider 时，在瀑布流单击后详情列表对应行立即 aria-selected=true——切换视图不清空选择/活动项/查询/排序。测试 9 项（含 promptSort 单测）：万级窗口上限、规格列呈现、无标题回落正文首行、表头回调与 aria-sort 方向声明、双视图选择互通。
- [x] 10.3 实现提示词检查器当前正文、标题/模型/参数、组织、备注、关联图片与长文本聚焦编辑器
  - 2026-08-22 落地：新建 `PromptWorkspace` 外壳（App.tsx 提示词一级入口由"尚未实现"占位换成真工作区，refreshVersion 与图片侧共享同一 catalogVersion）——查询状态（搜索经 useDeferredValue、标签多选、文件夹、只看收藏、active/trash 位置）驱动 prompt_snapshot，左分类栏派生自快照 folders（后端无提示词文件夹 CRUD，树由成员关系派生），回收站入口带 trash_count；视图/排序/筛选保持组件内状态，布局偏好只消费 "prompts-waterfall"/"prompts-list" 滚动键（顶层 view/folder/tags/favorite 字段归图片侧所有，避免双工作区互相覆盖）。新建 `PromptInspector`：四个可定位分区 data-inspector-section=info|organization|note|images——info 呈现标题（promptDisplayTitle）/模型/参数说明/更新时间/关联图片数加完整正文 pre 与聚焦阅读按钮；organization 提供文件夹勾选 + 新建文件夹路径表单（并入归属数组）+ 共享标签增删；note 本切片只读呈现权威值；images 以方格懒加载缩略图列出关联哈希（复用 useLazyThumbnailUrl），空关联给建立关联的出路文案。新建 `PromptBodyFocus` 聚焦阅读占满中央区替换集合视图，退出回原列表位置由滚动恢复机制保证（测试证明偏移往返）。styles.css 补 prompt-body-focus/focus-body/inspector-body-full/linked-thumbs 及三栏栅格的 .prompt-workspace 分组选择器。测试 13 项：组合查询五要素进请求、单击更新检查器不替换集合、聚焦阅读进出、收藏独立 IPC、组织勾选/新路径/标签回路、备注只读与空态、关联图列表、多选摘要、视图切换零重查保留选择排序、滚动位置恢复。
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
