import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { parseAssetId, type AssetId, type LibraryId } from "../../../app/common";
import { renameAssetDisplayFilename } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import type { AssetRow } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import { assetKeys } from "./queryKeys";
import styles from "./AssetFilename.module.css";

export type FilenameTarget = { hash: AssetId; stem: string; extension: string; sourceFilename: string };

/** v3 显示名已经由 Rust 校验；不猜测或修补违反真实扩展名契约的元数据。 */
export function filenameTarget(asset: AssetRow): FilenameTarget {
  const suffix = `.${asset.ext}`;
  if (!asset.display_filename.endsWith(suffix) || asset.display_filename.length <= suffix.length) throw new TypeError("显示文件名与素材真实扩展名不一致");
  return { hash: parseAssetId(asset.hash), stem: asset.display_filename.slice(0, -suffix.length), extension: asset.ext, sourceFilename: asset.original_filename };
}

/** 文件身份区；来源记录始终只读，不暴露可写的库内哈希对象。 */
export function FileInformation({ asset, count, editable, onEdit }: { asset: AssetRow | null; count: number; editable: boolean; onEdit: () => void }): ReactNode {
  return <section className={styles.information} aria-label="图片文件信息">
    {asset === null ? <p>{count > 1 ? "请选择单张图片编辑文件名，不支持批量重命名。" : "选择一张图片查看文件信息。"}</p> : <>
      <dl>
        <div><dt>显示文件名</dt><dd>{asset.display_filename}</dd></div>
        <div><dt>来源文件名</dt><dd>{asset.original_filename}</dd></div>
        <div><dt>真实扩展名</dt><dd translate="no">.{asset.ext}</dd></div>
        <div><dt>媒体类型</dt><dd>{asset.media_type}</dd></div>
        <div><dt>原始字节数</dt><dd>{asset.byte_size.toLocaleString("zh-CN")} 字节</dd></div>
        <div><dt>导入时间</dt><dd><time dateTime={asset.imported_at}>{new Date(asset.imported_at).toLocaleString("zh-CN")}</time></dd></div>
        <div><dt>来源路径</dt><dd>{asset.source_path === null ? "未记录来源路径" : asset.source_path}</dd></div>
        <div><dt>内容哈希（{asset.hash_algo}）</dt><dd translate="no">{asset.hash}</dd></div>
      </dl>
      <Button size="compact" disabled={!editable} onClick={onEdit}>编辑显示文件名</Button>
      <p className={styles.hint}>修改显示名称不会重命名库内原图，也不会改变来源记录。</p>
    </>}
  </section>;
}

/** 一次打开对应一个编辑会话；关闭会卸载表单，旧错误不会泄漏到下次 F2。 */
function FilenameForm({ libraryId, target, onClose, inputRef }: {
  libraryId: LibraryId;
  target: FilenameTarget;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}): ReactNode {
  const client = useQueryClient();
  const inputId = useId();
  const extensionId = useId();
  const errorId = useId();
  const [stem, setStem] = useState(target.stem);
  const save = useMutation({
    mutationKey: assetKeys.renameFilename(libraryId),
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (request: { hash: AssetId; stem: string }) => renameAssetDisplayFilename(request.hash, request.stem),
    onSuccess: async (_result, request) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: assetKeys.collections(libraryId) }),
        client.invalidateQueries({ queryKey: assetKeys.detail(libraryId, request.hash), exact: true }),
      ]);
      onClose();
    },
  });
  useLayoutEffect(() => {
    if (save.error instanceof IpcError && save.error.appError.code === "library.filename_invalid") inputRef.current?.focus();
  }, [save.error, inputRef]);
  if (save.error !== null && !(save.error instanceof IpcError)) throw save.error;
  return <form className={styles.form} onSubmit={(event) => {
    event.preventDefault();
    save.mutate({ hash: target.hash, stem });
  }}>
    <label htmlFor={inputId}>名称主体</label>
    <div className={styles.filenameField}>
      <input ref={inputRef} id={inputId} name="display-filename-stem" value={stem} autoComplete="off" spellCheck={false} required disabled={save.isPending}
        aria-describedby={save.isError ? `${extensionId} ${errorId}` : extensionId} aria-invalid={save.error?.appError.code === "library.filename_invalid"}
        onChange={(event) => setStem(event.target.value)} />
      <span id={extensionId} className={styles.extension} translate="no">.{target.extension}</span>
    </div>
    <p className={styles.source}>来源文件名：{target.sourceFilename}</p>
    {save.error === null ? null : <p id={errorId} role="alert" className={styles.error}>{save.error.message}</p>}
    <Button type="submit" variant="primary" disabled={save.isPending || stem.trim().length === 0}>{save.isPending ? "正在保存…" : "保存文件名"}</Button>
  </form>;
}

/** 打开时的 target 固定写入身份；刷新、查询和选择变化不覆盖尚未保存的输入。 */
export function RenameAssetDialog({ libraryId, target, disabled, onOpen, onClose, restoreFocus }: {
  libraryId: LibraryId;
  target: FilenameTarget | null;
  disabled: boolean;
  onOpen: () => void;
  onClose: () => void;
  restoreFocus: () => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useIsMutating({ mutationKey: assetKeys.renameFilename(libraryId), exact: true }) > 0;
  return <Dialog title="修改显示文件名" description="只修改名称主体，真实扩展名、来源文件名和图片本体保持不变。"
    open={target !== null}
    onOpenChange={(next) => {
      if (busy) return;
      if (next) onOpen();
      else onClose();
    }}
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      const input = inputRef.current;
      if (input === null) throw new Error("重命名对话框缺少输入框");
      input.focus(); input.select();
    }}
    onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}
    trigger={<Button size="compact" disabled={disabled}>修改文件名</Button>}>
    {target === null ? null : <FilenameForm key={target.hash} libraryId={libraryId} target={target} onClose={onClose} inputRef={inputRef} />}
  </Dialog>;
}
