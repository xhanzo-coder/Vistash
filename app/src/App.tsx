import { useCallback, useEffect, useRef, useState } from "react";

import { AssetWorkspace } from "./features/assets/AssetWorkspace";
import { ErrorLine } from "./features/library/ErrorLine";
import { LibraryPicker } from "./features/library/LibraryPicker";
import { asAppError } from "./shared/errors";
import { importPaths, libraryStatus, onPathsDropped } from "./shared/ipc";
import type {
  AppError,
  ImportOutcome,
  ImportProgress,
  LibraryStatus,
} from "./shared/types";

/** 一级导航入口。 */
type Section = "assets" | "prompts";

/**
 * 应用根组件。
 *
 * 库、素材、选中项与导入状态都只由根组件协调。设计第六条据此决定不引入状态管理库——
 * 尚无跨路由共享或复杂派生缓存时，引入 Redux 或 Zustand 只有抽象成本。
 */
export function App() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [statusError, setStatusError] = useState<AppError | null>(null);
  const [section, setSection] = useState<Section>("assets");
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
      <header className="app-header">
        <div className="brand-block">
          <p className="eyebrow">VISUAL ARCHIVE / WINDOWS</p>
          <h1>Vistash</h1>
        </div>
        <p className="library-path" title={status.path}>当前库：{status.path}</p>
      </header>

      {/*
        导航骨架。素材与提示词库并列为一级入口，且提示词库必须是一级入口而不是素材详情的
        侧栏——规格的理由是结构性的：提示词是一等资产，存在不关联任何素材的手写记录，
        侧栏在结构上容纳不了这类记录。
      */}
      <nav aria-label="主导航" className="primary-nav">
        <button
          type="button"
          aria-current={section === "assets" ? "page" : undefined}
          onClick={() => setSection("assets")}
        >
          素材
        </button>
        <button
          type="button"
          aria-current={section === "prompts" ? "page" : undefined}
          onClick={() => setSection("prompts")}
        >
          提示词库
        </button>
      </nav>

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
            未实现的入口必须显式说明"尚未实现"，禁止渲染成空列表：空列表与"库中确实没有
            内容"无法区分，会使使用者误判功能已存在但数据丢失。
          */
          <section>
            <h2>提示词库</h2>
            <p>
              <strong>尚未实现。</strong>
              提示词的录入、反推产出与检索将在后继变更中加入。此处先占住一级入口的位置，
              以免日后加入时改动导航层级。
            </p>
          </section>
        ) : (
          <AssetWorkspace refreshVersion={catalogVersion} />
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
