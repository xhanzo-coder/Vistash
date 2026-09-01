import { useState } from "react";

import { asAppError } from "../../shared/errors";
import { migrateLibrary } from "../../shared/ipc";
import type { AppError, LibraryStatus, MigrationProgress } from "../../shared/types";
import { ErrorLine } from "./ErrorLine";

/**
 * 迁移阶段的稳定字面量到可读说明的映射。
 *
 * 键是后端 `MigrationStage::as_str` 的取值。未登记的阶段原样显示字面量：宁可让使用者
 * 看到一个英文标识，也不编一句可能说谎的文案。
 */
const STAGE_TEXT: Readonly<Record<string, string>> = {
  started: "准备迁移",
  skeleton_ready: "建立提示词骨架",
  sidecars_rewritten: "重写素材元数据",
  index_rebuilt: "重建派生索引",
  committed: "提交新库版本",
};

/**
 * 库格式迁移的阻塞页。
 *
 * 开库发现 v1 时启动**明确**的一次性迁移：这一页就是"明确"的落点——
 * 使用者看到要发生什么、主动点击开始，并在迁移期间被阻塞在进度上。迁移会先备份原始
 * 文件、任何一步失败都恢复原状，因此这里不需要取消按钮；中途关闭窗口等价于中断，
 * 下次打开时后端会依据 journal 继续或回滚。
 */
export function LibraryMigration({
  path,
  problem,
  onOpened,
}: {
  /** 待迁移的库目录。 */
  path: string;
  /** 进入本页的原因（通常是 library.format_too_old）。必须连同错误码一起呈现。 */
  problem: AppError | null;
  /** 迁移成功后上交新的库状态，由根组件切换进工作区。 */
  onOpened: (status: LibraryStatus) => void;
}) {
  const [migrating, setMigrating] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  async function start() {
    setError(null);
    setMigrating(true);
    setProgress(null);
    try {
      onOpened(await migrateLibrary(path, setProgress));
    } catch (raw) {
      setError(asAppError(raw));
    } finally {
      setMigrating(false);
      setProgress(null);
    }
  }

  return (
    <main>
      <h1>Vistash</h1>
      <h2>迁移到新的库格式</h2>

      {problem !== null && <ErrorLine error={problem} />}

      <p>
        这个库还是旧版本格式，没有损坏。Vistash 需要先把它一次性升级到新格式才能打开：
        迁移会备份原始文件，全部完成才提交新版本；任何一步失败都会自动恢复原状。
      </p>
      <p>迁移期间请不要关闭窗口，也不要改动库文件夹（{path}）中的任何文件。</p>

      {/* 迁移进行中禁用按钮：再次点击会与 journal 状态竞争，没有任何正当场景。 */}
      <button type="button" onClick={() => void start()} disabled={migrating}>
        {migrating ? "正在迁移…" : "开始迁移"}
      </button>

      {migrating && (
        <p role="status">
          {progress === null
            ? "正在准备迁移…"
            : `${
                STAGE_TEXT[progress.stage] ?? progress.stage
              } ${progress.done}/${progress.total}${
                progress.current_filename === ""
                  ? ""
                  : `：${progress.current_filename}`
              }`}
        </p>
      )}
      {error !== null && <ErrorLine error={error} />}
    </main>
  );
}
