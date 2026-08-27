import { useCallback, useEffect, useRef, useState } from "react";

import { AssetWorkspace } from "./features/assets/AssetWorkspace";
import { ErrorLine } from "./features/library/ErrorLine";
import { blockIfPromptDraftDirty } from "./features/prompts/draftGuard";
import { promptDropClaimsLatestPoint } from "./features/prompts/promptDropZone";
import { PromptWorkspace } from "./features/prompts/PromptWorkspace";
import { LibraryPicker } from "./features/library/LibraryPicker";
import { GlobalSearchPanel, type GlobalLocateRequest } from "./features/workspace/GlobalSearch";
import {
  WorkspaceTopBar,
  type WorkspaceSection,
} from "./features/workspace/WorkspaceTopBar";
import { asAppError } from "./shared/errors";
import { importSources, libraryStatus, onPathsDropped, pasteImport } from "./shared/ipc";
import { shouldClaimPaste } from "./features/assets/pasteClaim";
import type {
  AppError,
  ImportOutcome,
  TransferProgress,
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
  const [closeProtectionError, setCloseProtectionError] = useState<string | null>(null);
  const [section, setSection] = useState<WorkspaceSection>("assets");
  const [assetsError, setAssetsError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const importingRef = useRef(false);
  // 全局搜索的定位请求（任务 11.1）：nonce 单调递增，同一目标重复进入也能再次生效。
  const [locate, setLocate] = useState<(GlobalLocateRequest & { nonce: number }) | null>(null);
  const locateNonce = useRef(0);

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

  // 统一导入的驱动入口：拖放/选择交来路径列表，窗口级 Ctrl+V 交 null（后端
  // 自行读剪贴板分流）。两者共用同一进度显示与并发闸。
  const runImport = useCallback(
    async (paths: string[] | null) => {
      if ((paths !== null && paths.length === 0) || importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      setTransferProgress(null);
      try {
        // 整窗口拖放暂不带当前文件夹（落点接线随任务 10.2）：后端按 null 落入
        // 未分类。按钮与目录选择接入时传各自的具体文件夹即可复用同一协调器。
        setOutcome(
          paths === null
            ? await pasteImport(null, setTransferProgress)
            : await importSources(paths, null, setTransferProgress),
        );
        setCatalogVersion((version) => version + 1);
      } catch (raw) {
        setAssetsError(asAppError(raw));
      } finally {
        importingRef.current = false;
        setImporting(false);
        setTransferProgress(null);
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
        const fn = await onPathsDropped((paths) => {
          // 落点被提示词关联图片区认领时让路（任务 10.5）：那次拖放的语义是
          // "导入并关联到当前提示词"，不是整库导入。判定只读共享的落点快照，
          // 与两个监听者的触发顺序无关。
          if (promptDropClaimsLatestPoint()) return;
          void runImport(paths);
        });
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

  // 窗口级 Ctrl+V（任务 5.3，设计第十一条）：只在图片工作区处于前台且事件目标
  // 不属于可编辑控件时认领；备注、搜索框等文本编辑位置保持原生粘贴。剪贴板上
  // 是什么由后端裁决——前端只决定按键归属，不见任何像素。
  useEffect(() => {
    if (opened === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key !== "v" && event.key !== "V") return;
      if (section !== "assets") return;
      if (!shouldClaimPaste(event.target)) return;
      event.preventDefault();
      void runImport(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [opened, section, runImport]);

  // 未保存主字段草稿的窗口级拦截（任务 10.4）：关闭窗口前先问保存/放弃/留在
  // 当前页。只在 Tauri 运行时里可用；纯浏览器/测试环境没有原生关闭事件可拦。
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const reportCloseFailure = (raw: unknown) => {
          if (!cancelled) setCloseProtectionError(String(raw));
        };
        const fn = await currentWindow.onCloseRequested((event) => {
          // SDK 默认在回调后直接 destroy；由本层接管才能呈现该阶段的权限/平台错误。
          event.preventDefault();
          const continueClose = () => { void currentWindow.close().catch(reportCloseFailure); };
          if (!blockIfPromptDraftDirty(continueClose)) {
            void currentWindow.destroy().catch(reportCloseFailure);
          }
        });
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (raw) {
        // 原生订阅失败不能与“当前没有草稿”混同；提示贯穿选库和工作台，不被导入清除。
        if (!cancelled) setCloseProtectionError(String(raw));
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten !== null) unlisten();
    };
  }, []);

  const runAfterDraftGuard = useCallback((action: () => void): boolean => {
    if (blockIfPromptDraftDirty(action)) return false;
    action();
    return true;
  }, []);

  /** 一级入口切换：提示词侧有未保存草稿时先要三选一。返回是否已切换。 */
  const handleSectionChange = useCallback(
    (next: WorkspaceSection) => {
      if (next === section) return true;
      return runAfterDraftGuard(() => setSection(next));
    },
    [runAfterDraftGuard, section],
  );

  /** 全局搜索结果的定位（任务 11.1）：切到目标库并把查询重置到能看见该项的位置。 */
  const handleGlobalLocate = useCallback(
    (request: GlobalLocateRequest) => {
      runAfterDraftGuard(() => {
        setSection(request.section);
        locateNonce.current += 1;
        setLocate({ ...request, nonce: locateNonce.current });
      });
    },
    [runAfterDraftGuard],
  );

  const handleLocateHandled = useCallback((nonce: number) => {
    setLocate((current) =>
      current !== null && current.nonce === nonce ? null : current,
    );
  }, []);

  const closeProtectionNotice = closeProtectionError !== null ? (
    <p role="alert">
      关闭保护不可用，请先保存正文再关闭窗口。原因：{closeProtectionError}
    </p>
  ) : null;

  if (statusError !== null) {
    return (
      <main>
        <h1>Vistash</h1>
        {closeProtectionNotice}
        <p>读取应用状态失败。</p>
        <ErrorLine error={statusError} />
      </main>
    );
  }

  if (status === null) {
    return (
      <main>
        <h1>Vistash</h1>
        {closeProtectionNotice}
        <p>正在启动…</p>
      </main>
    );
  }

  if (status.path === null) {
    return (
      <>
        {closeProtectionNotice}
        <LibraryPicker
        problem={status.problem}
        recordedPath={status.recorded_path}
        onOpened={(next) => {
          setStatus(next);
          setOutcome(null);
          setCatalogVersion((version) => version + 1);
        }}
        />
      </>
    );
  }

  return (
    <div className="app-shell">
      {closeProtectionNotice}
      <a className="skip-link" href="#main-content">跳到主内容</a>

      {/*
        紧凑顶栏（任务 8.1）。素材与提示词库并列为一级入口，且提示词库必须是一级入口而
        不是素材详情的侧栏——规格的理由是结构性的：提示词是一等资产，存在不关联任何
        素材的手写记录，侧栏在结构上容纳不了这类记录。
      */}
      <WorkspaceTopBar
        section={section}
        onSectionChange={handleSectionChange}
        libraryPath={status.path}
        actions={<GlobalSearchPanel onLocate={handleGlobalLocate} />}
      />

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
          <PromptWorkspace
            refreshVersion={catalogVersion}
            libraryId={status.library_id}
            locate={locate?.section === "prompts" ? locate : null}
            onLocateHandled={handleLocateHandled}
          />
        ) : (
          <AssetWorkspace
            refreshVersion={catalogVersion}
            libraryId={status.library_id}
            locate={locate?.section === "assets" ? locate : null}
            onLocateHandled={handleLocateHandled}
          />
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
        {outcome.duplicates > 0 && `，${outcome.duplicates} 个库内已有相同内容`}
        {outcome.pending_count > 0 && `，停止后有 ${outcome.pending_count} 个未处理`}
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
