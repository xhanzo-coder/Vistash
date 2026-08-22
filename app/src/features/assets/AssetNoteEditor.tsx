import { setAssetNote } from "../../shared/ipc";
import { NoteAutoSaveEditor } from "../workspace/NoteAutoSaveEditor";

/**
 * 图片备注编辑器（任务 9.4）。
 *
 * 自动保存状态机实现在共享的 `NoteAutoSaveEditor`（任务 10.4 抽取，提示词备注
 * 共用同一台机器）；这里只注入图片侧的写入命令与无障碍命名。调用方以 hash 作
 * key 渲染本组件——换活动项即重新挂载，草稿与状态从权威值重新开始。
 */
export function AssetNoteEditor({ hash, note }: { hash: string; note: string }) {
  return (
    <NoteAutoSaveEditor
      label="图片备注"
      initial={note}
      save={(text) => setAssetNote(hash, text)}
    />
  );
}
