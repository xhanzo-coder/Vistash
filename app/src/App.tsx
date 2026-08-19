import { useCallback, useEffect, useState } from "react";

import { AssetGrid } from "./features/assets/AssetGrid";
import { AssetPreview } from "./features/assets/AssetPreview";
import { ErrorLine } from "./features/library/ErrorLine";
import { LibraryPicker } from "./features/library/LibraryPicker";
import { asAppError } from "./shared/errors";
import { importPaths, libraryStatus, listAssets, onPathsDropped } from "./shared/ipc";
import type { AppError, AssetRow, ImportOutcome, LibraryStatus } from "./shared/types";

/** 一级导航入口。 */
type Section = "assets" | "prompts";

/**
 * 应用根组件。
 *
 * 状态只有四块：库状态、素材列表、选中项、导入结果。设计第六条据此决定不引入状态管理库——
 * 只有这几块时，引入 Redux 或 Zustand 是先付抽象成本而没有对应收益。
 */
export function App() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [statusError, setStatusError] = useState<AppError | null>(null);
  const [section, setSection] = useState<Section>("assets");
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [assetsError, setAssetsError] = useState<AppError | null>(null);
  const [selected, setSelected] = useState<AssetRow | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [importing, setImporting] = useState(false);

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

  // 先取数据再改状态：若一进函数就 setAssetsError(null)，从 effect 调用它就等于在
  // effect 里同步 setState，会白多跑一轮渲染。
  const refresh = useCallback(async () => {
    try {
      const next = await listAssets();
      setAssets(next);
      setAssetsError(null);
    } catch (raw) {
      setAssetsError(asAppError(raw));
    }
  }, []);

  useEffect(() => {
    if (opened === null) return undefined;
    const load = async () => {
      await refresh();
    };
    void load();
    return undefined;
  }, [opened, refresh]);

  const runImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setImporting(true);
      try {
        setOutcome(await importPaths(paths));
        await refresh();
      } catch (raw) {
        setAssetsError(asAppError(raw));
      } finally {
        setImporting(false);
      }
    },
    [refresh],
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
        onOpened={(next) => {
          setStatus(next);
          setSelected(null);
          setOutcome(null);
        }}
      />
    );
  }

  return (
    <div>
      <header>
        <h1>Vistash</h1>
        <p>当前库：{status.path}</p>
      </header>

      {/*
        导航骨架。素材与提示词库并列为一级入口，且提示词库必须是一级入口而不是素材详情的
        侧栏——规格的理由是结构性的：提示词是一等资产，存在不关联任何素材的手写记录，
        侧栏在结构上容纳不了这类记录。
      */}
      <nav aria-label="主导航">
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

      <main>
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
        ) : selected !== null ? (
          <AssetPreview
            key={selected.hash}
            asset={selected}
            onClose={() => setSelected(null)}
          />
        ) : (
          <section>
            <h2>素材</h2>
            <p>把图片文件或文件夹拖进窗口即可导入。支持 PNG、JPEG、WebP、GIF 与 BMP。</p>
            {importing && <p role="status">正在导入…</p>}
            {outcome !== null && <ImportSummary outcome={outcome} />}
            {assetsError !== null && <ErrorLine error={assetsError} />}
            <AssetGrid assets={assets} onSelect={setSelected} />
          </section>
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
