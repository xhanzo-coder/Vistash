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
  "trash.restore_target_folder_missing": "还原失败：素材删除前所属的文件夹已不存在。",
  "trash.purge_failed": "彻底删除失败。",

  // color_card 域
  "color_card.decode_failed": "色卡计算失败：图片无法解码。",
  "color_card.insufficient_opaque_pixels": "色卡计算失败：不透明像素太少，无法得出代表色。",
  "color_card.cluster_failed": "色卡计算失败：聚类结果不可用。",

  // library 域
  "library.not_found": "这个位置不是 Vistash 库。",
  "library.path_unreadable": "读不到库目录。它可能已被移动、删除，或当前账户没有读取权限。",
  "library.format_too_new": "这个库的格式版本高于当前程序支持的版本，已拒绝打开以免损坏数据。请升级 Vistash。",
  "library.metadata_corrupt": "库的元数据文件损坏，已拒绝打开。程序不会自行重建它——哈希算法标识无法从素材反推，猜错会让全库去重判定失效。",
  "library.directory_not_empty": "这个目录里已有其他文件，不能在其中建库。请选择一个空目录，或选择一个已有的 Vistash 库。",
  "library.create_failed": "建立库目录失败。",
  "library.io_failed": "读写库目录失败。",
  "library.index_rebuild_failed": "索引重建失败。索引是派生数据，可在修复后重试。",
  "library.thumbnail_failed": "缩略图生成失败。",
  "library.settings_corrupt": "应用设置文件损坏，已无法读出上次打开的库。请重新选择库位置。",
};
