/**
 * 错误码到中文文案的映射。**全项目唯一一处。**
 *
 * 界面必须同时呈现错误码本身与这份可读说明，不得只显示通用失败文案——`app-shell` 规格的
 * 理由是：错误码是本项目诊断问题的唯一稳定标识，只给通用文案会让失败无法归因。
 *
 * 这张表的完整性由 Rust 侧的测试守着（见 `src-tauri` 的 `error_text_covers_every_code`）：
 * 新增错误码却忘了在这里加文案，`cargo test` 会失败。因此不要把这张表改成动态生成——
 * 那样就失去了这道检查。
 */
export const ERROR_TEXT: Readonly<Record<string, string>> = {
  // import 域
  "import.source_unreadable": "读不到源文件。它可能已被移动、删除，或当前账户没有读取权限。",
  "import.unsupported_media_type": "不支持这种图片格式。本版支持 PNG、JPEG、WebP、GIF 与 BMP。",
  "import.decode_failed": "图片无法解码。文件可能已损坏，或扩展名与真实格式不符。",
  "import.insufficient_space": "磁盘空间不足，无法写入库目录。",
  "import.copy_failed": "复制文件到库目录失败。已写入的部分已被清除。",
  "import.metadata_write_failed": "写入素材元数据失败。该素材已写入的部分已被清除。",
  "import.duplicate_in_library": "库中已有内容完全相同的素材，未重复入库。",
  "import.duplicate_in_trash": "回收站中已有内容完全相同的素材，未重复入库。",
  "import.cancelled": "导入被中断，该素材未入库。",

  // trash 域
  "trash.delete_failed": "把素材移入库内回收站失败。",
  "trash.restore_failed": "从库内回收站还原素材失败。",
  "trash.restore_target_folder_missing": "还原成功，但删除前的部分文件夹已不存在；缺失的归属已落回根位置，详情见下。",
  "trash.purge_failed": "彻底删除失败。",

  // color_card 域
  "color_card.decode_failed": "色卡计算失败：图片无法解码。",
  "color_card.insufficient_opaque_pixels": "色卡计算失败：不透明像素太少，无法得出代表色。",
  "color_card.cluster_failed": "色卡计算失败：聚类结果不可用。",

  // library 域
  "library.not_found": "这个位置不是 Vistash 库。",
  "library.path_unreadable": "读不到库目录。它可能已被移动、删除，或当前账户没有读取权限。",
  "library.format_too_new": "这个库的格式版本高于当前程序支持的版本，已拒绝打开以免损坏数据。请升级 Vistash。",
  "library.format_too_old": "这个库还是旧版本格式。它没有损坏——启动一次性迁移后即可打开，迁移会先备份原始文件。",
  "library.metadata_corrupt": "库的元数据文件损坏，已拒绝打开。程序不会自行重建它——哈希算法标识无法从素材反推，猜错会让全库去重判定失效。",
  "library.directory_not_empty": "这个目录里已有其他文件，不能在其中建库。请选择一个空目录，或选择一个已有的 Vistash 库。",
  "library.create_failed": "建立库目录失败。",
  "library.io_failed": "读写库目录失败。",
  "library.index_rebuild_failed": "索引重建失败。索引是派生数据，可在修复后重试。",
  "library.thumbnail_failed": "缩略图生成失败。",
  "library.settings_corrupt": "应用设置文件损坏，已无法读出上次打开的库。请重新选择库位置。",
  "library.folder_invalid": "文件夹名称或路径无效。",
  "library.folder_exists": "同名文件夹已经存在。",
  "library.folder_not_found": "指定的文件夹不存在。",
  "library.tag_invalid": "标签不能为空且不能包含控制字符。",
  "library.filename_invalid": "显示文件名不能为空、不能包含路径字符，也不能自行伪造图片扩展名。",
  "library.asset_metadata_write_failed": "写入素材组织元数据失败。",

  // prompt 域
  "prompt.metadata_corrupt": "提示词文件损坏，已拒绝载入。程序不会自行猜测缺失字段——猜出来的正文会永久顶替使用者真正写过的内容。",
  "prompt.format_too_new": "这条提示词的文件格式版本高于当前程序支持的版本，已拒绝载入以免写坏数据。请升级 Vistash。",
  "prompt.write_failed": "写入提示词失败。当前编辑内容仍保留在编辑器中，未被丢弃。",
  "prompt.body_empty": "提示词正文不能为空。请至少填写一行正文，标题、模型与参数说明可以留空。",
  "prompt.id_invalid": "提示词标识非法。这通常意味着库内文件被外部程序改写过。",
  "prompt.cover_not_linked": "封面必须是这条提示词已关联的图片。请先建立关联，再把它设为封面。",
  "prompt.linked_image_duplicated": "同一张图片不能与同一条提示词重复关联。",
  "prompt.not_found": "找不到这条提示词。它可能已被删除，或列表已过期——请刷新后重试。",
  "prompt.folder_not_found": "指定的提示词文件夹不存在。提示词文件夹与素材文件夹是两棵独立的树。",
  "prompt.folder_exists": "同名提示词文件夹已经存在。",
  "prompt.trash_delete_failed": "把提示词移入提示词回收站失败。原提示词未被改动，可重试。",
  "prompt.trash_restore_failed": "从提示词回收站还原提示词失败。回收站中的提示词未被改动，可重试。",
  "prompt.trash_purge_failed": "彻底删除这条提示词失败。它仍保留在提示词回收站中，其余条目不受影响。",
  "prompt.linked_image_not_found": "要关联的图片不在图片库中。请从图片库重新选择。",

  // migration 域
  "migration.journal_corrupt": "库迁移记录损坏，已停止迁移。程序不会据此继续或回滚——两者都可能写坏权威数据。请保留库目录并联系支持。",
  "migration.journal_format_too_new": "库迁移记录来自更高版本的 Vistash，当前版本无法继续这次迁移。请升级 Vistash。",
  "migration.journal_write_failed": "写入库迁移记录失败，迁移未开始或已停在上一个已记录的步骤。库内数据保持可恢复状态。",
  "migration.lock_held": "另一次库迁移正在进行，已拒绝重复开始。若上一次迁移被强制结束，请重新打开这个库以继续或回滚它。",
  "migration.interrupted": "库迁移被中断。库仍处于可恢复状态：下次打开这个库会继续未完成的迁移或回滚它，不会把半迁移的库当成正常库。",
  "migration.backup_failed": "备份原始元数据失败，迁移未改动任何权威文件。",
  "migration.sidecar_rewrite_failed": "重写素材元数据失败，已按备份把此前处理过的文件全部恢复原状。",
  "migration.commit_failed": "提交新库版本失败。库仍是旧版本，已处理的文件已恢复原状。",
  "migration.rollback_failed": "迁移回滚失败，库可能同时存在新旧两种元数据。请不要继续使用这个库，保留目录并联系支持。",
  "migration.resolution_invalid": "文件夹迁移选择无效。每个多归属素材必须且只能选择一个原文件夹。",
  "migration.plan_stale": "迁移计划生成后库内容发生了变化。请重新扫描并处理新的冲突列表。",
  "migration.staging_failed": "写入新格式暂存区失败，库内文件未被改动。请确认磁盘可写、空间充足后重试。",
};
