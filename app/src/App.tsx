import { useCallback, useEffect, useRef, useState } from "react";

import { AssetWorkspace } from "./features/assets/AssetWorkspace";
import { ErrorLine } from "./features/library/ErrorLine";
import { PromptWorkspace } from "./features/prompts/PromptWorkspace";
import { LibraryPicker } from "./features/library/LibraryPicker";
import {
  WorkspaceTopBar,
  type WorkspaceSection,
} from "./features/workspace/WorkspaceTopBar";
import { asAppError } from "./shared/errors";
import { importPaths, libraryStatus, onPathsDropped } from "./shared/ipc";
import type {
  AppError,
  ImportOutcome,
  ImportProgress,
  LibraryStatus,
} from "./shared/types";

/**
 * 应用根组件。
 *
 * 库、素材、选中项与导入状态都只由根组件协调。设计第六条据此决定不引入状态管理库——
 * 尚无跨路由共享或复杂派生缓存时，引入 Redux 或 Zustand 只有抽象成本。
 */
export function App() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [statusError, setStatusError] = useState<AppError | null>(null);
  const [section, setSection] = useState<WorkspaceSection>("assets");
  const [assetsError, setAssetsError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const importingRef = useRef(false);

  useEffect(() => {
    const load = async () => {
      try {
        setStatus(await libraryStatus());
      } catch (raw) {
        setStatusError(asAppError(raw));
      }
    };
    void load();
  }, []);

  const opened = status?.path ?? null;

  const runImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      setImportProgress(null);
      try {
        setOutcome(await importPaths(paths, setImportProgress));
        setCatalogVersion((version) => version + 1);
      } catch (raw) {
        setAssetsError(asAppError(raw));
      } finally {
        importingRef.current = false;
        setImporting(false);
        setImportProgress(null);
      }
    },
    [],
  );

  // 拖入监听只在库已打开时挂上：没有库时导入无处可去，而拖进来却什么都不发生
  // 会让人以为程序卡住了——所以宁可不接收，由界面文案说明先要选库。
  useEffect(() => {
    if (opened === null) return undefined;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const listen = async () => {
      try {
        const fn = await onPathsDropped((paths) => void runImport(paths));
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (raw) {
        if (!cancelled) setAssetsError(asAppError(raw));
      }
    };
    void listen();

    return () => {
      cancelled = true;
      if (unlisten !== null) unlisten();
    };
  }, [opened, runImport]);

  if (statusError !== null) {
    return (
      <main>
        <h1>Vistash</h1>
        <p>读取应用状态失败。</p>
        <ErrorLine error={statusError} />
      </main>
    );
  }

  if (status === null) {
    return (
      <main>
        <h1>Vistash</h1>
        <p>正在启动…</p>
      </main>
    );
  }

  if (status.path === null) {
    return (
      <LibraryPicker
        problem={status.problem}
        recordedPath={status.recorded_path}
        onOpened={(next) => {
          setStatus(next);
          setOutcome(null);
          setCatalogVersion((version) => version + 1);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主内容</a>

      {/*
        紧凑顶栏（任务 8.1）。素材与提示词库并列为一级入口，且提示词库必须是一级入口而
        不是素材详情的侧栏——规格的理由是结构性的：提示词是一等资产，存在不关联任何
        素材的手写记录，侧栏在结构上容纳不了这类记录。
      */}
      <WorkspaceTopBar section={section} onSectionChange={setSection} libraryPath={status.path} />

      {importing && (
        <p role="status">
          {importProgress === null
            ? "正在扫描待导入文件…"
            : `正在导入 ${importProgress.done}/${importProgress.total}${
                importProgress.current_filename === null
                  ? ""
                  : `：${importProgress.current_filename}`
              }`}
        </p>
      )}
      {outcome !== null && <ImportSummary outcome={outcome} />}
      {assetsError !== null && <ErrorLine error={assetsError} />}

      <main id="main-content" className="app-main">
        {section === "prompts" ? (
          /*
            提示词工作区（任务 10.3）：与图片侧同级的一等工作区。refreshVersion 与
            图片侧共享同一 catalogVersion——任一侧的结构性变更都推进它，两个工作区
            各自按需刷新自己的快照。
          */
          <PromptWorkspace refreshVersion={catalogVersion} libraryId={status.library_id} />
        ) : (
          <AssetWorkspace refreshVersion={catalogVersion} libraryId={status.library_id} />
        )}
      </main>
    </div>
  );
}

/**
 * 一次导入的结果。
 *
 * 失败逐条列出而不是只报总数——规格明确要求批量操作中的失败可逐条查看，否则使用者
 * 无法知道是哪几个文件没进来。
 */
function ImportSummary({ outcome }: { outcome: ImportOutcome }) {
  return (
    <section>
      <h3>导入结果</h3>
      <p>
        成功 {outcome.imported} 个
        {outcome.failures.length > 0 && `，失败 ${outcome.failures.length} 个`}
        {outcome.skipped_non_images > 0 &&
          `。另有 ${outcome.skipped_non_images} 个非图片文件未纳入`}
      </p>
      {outcome.failures.length > 0 && (
        <ul>
          {outcome.failures.map((failure) => (
            <li key={failure.source_path}>
              <p>{failure.original_filename}</p>
              <ErrorLine error={failure.error} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
