import { setPromptNote } from "../../shared/ipc";
import { NoteAutoSaveEditor } from "../workspace/NoteAutoSaveEditor";

/**
 * 提示词备注编辑器。
 *
 * 与图片备注共用同一台自动保存状态机（停止输入 800ms、失焦、Ctrl+Enter 三个
 * 触发时机，失败保留草稿）；这里只注入提示词侧的写入命令与无障碍命名。备注是
 * 独立自动保存流：不推进更新时间，也不参与主字段的显式保存/导航拦截。调用方以
 * 提示词 id 作 key 渲染——换活动项即重新挂载。
 */
export function PromptNoteEditor({ id, note }: { id: string; note: string }) {
  return (
    <NoteAutoSaveEditor
      draftKey={`prompt:${id}`}
      label="提示词备注"
      initial={note}
      save={(text) => setPromptNote(id, text)}
    />
  );
}
