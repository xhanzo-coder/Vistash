import { useState } from "react";

import { asAppError } from "../../shared/errors";
import { openLibrary, pickLibraryDirectory } from "../../shared/ipc";
import type { AppError, LibraryStatus } from "../../shared/types";
import { ErrorLine } from "./ErrorLine";

/**
 * 选库界面。
 *
 * 规格要求库位置必须由使用者显式选择，禁止在默认路径静默创建——库会承载素材本体的完整
 * 副本、规模可增长到数十 GB，落在系统盘的默认目录会产生使用者未同意的后果。因此这里
 * 没有"使用推荐位置"按钮，也不预填任何路径。
 *
 * `problem` 是上次记录的库路径不可用时的原因。它必须被呈现出来：只把人送回选择界面而不
 * 说明原因，使用者会以为素材丢了。
 */
export function LibraryPicker({
  problem,
  onOpened,
}: {
  problem: AppError | null;
  onOpened: (status: LibraryStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function choose() {
    setError(null);
    setBusy(true);
    try {
      const path = await pickLibraryDirectory();
      // 取消选择不是失败，因此不留下任何错误提示。
      if (path === null) return;
      onOpened(await openLibrary(path));
    } catch (raw) {
      setError(asAppError(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Vistash</h1>
      <h2>选择库位置</h2>

      {problem !== null && (
        <section>
          <p>上次使用的库无法打开：</p>
          <ErrorLine error={problem} />
        </section>
      )}

      <p>
        库是一个由你指定的普通文件夹。素材会被<strong>复制</strong>进去，因此它最终可能占用
        数十 GB——请选在空间充足的磁盘上。
      </p>
      <ul>
        <li>选一个空文件夹：Vistash 会在其中建立新库。</li>
        <li>选一个已有的 Vistash 库：直接打开，不改动其中任何文件。</li>
        <li>选一个已有其他文件的非库文件夹：会被拒绝，并说明原因。</li>
      </ul>

      <button type="button" onClick={() => void choose()} disabled={busy}>
        {busy ? "正在打开…" : "选择文件夹…"}
      </button>

      {error !== null && <ErrorLine error={error} />}
    </main>
  );
}
