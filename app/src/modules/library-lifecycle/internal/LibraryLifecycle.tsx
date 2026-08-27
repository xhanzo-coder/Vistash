import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { asAppError, formatError } from "../../../shared/errors";
import type { AppError, LibraryStatus } from "../../../shared/types";
import { parseLibraryId } from "../../../app/common";
import { Button } from "../../../ui/button/Button";
import { ConfirmDialog } from "../../../ui/dialog/Dialog";
import { Progress } from "../../../ui/progress/Progress";
import brandMark from "../../../assets/brand/vistash-mark.svg";
import type {
  MigrationProgress,
  V3FolderResolutionInput,
  V3MigrationPlan,
  V3MigrationPlanEntry,
} from "../../../shared/types";
import type {
  LibraryPickerPurpose,
  LibraryLifecyclePort,
  OpenLibraryContext,
} from "../index";
import styles from "./LibraryLifecycle.module.css";

const LIBRARY_STATUS_KEY = ["library-lifecycle", "status"] as const;
const CURRENT_LIBRARY_FORMAT_VERSION = 3;

type OperationState =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "failure"; path: string | null; error: AppError }
  | { kind: "preparing"; path: string; progress: MigrationProgress | null }
  | {
      kind: "planning";
      path: string;
      plan: V3MigrationPlan;
      resolutions: ReadonlyMap<string, string>;
    }
  | { kind: "committing"; path: string; progress: MigrationProgress | null };

type V3ConflictEntry = Extract<V3MigrationPlanEntry, { kind: "conflict" }>;

const NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");

function displayNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  if (normalized.length === 0) throw new TypeError(`库路径没有可显示名称：${path}`);
  const name = normalized.split(/[\\/]/).at(-1);
  if (name === undefined || name.length === 0) throw new TypeError(`库路径没有可显示名称：${path}`);
  return name;
}

function compatibleContext(status: LibraryStatus): OpenLibraryContext | null {
  if (status.path === null) return null;
  if (status.problem !== null) {
    throw new TypeError(`后端同时返回兼容库路径与问题：${formatError(status.problem)}`);
  }
  if (status.library_id === null) throw new TypeError("兼容库状态缺少 library_id");
  return {
    session: {
      id: parseLibraryId(status.library_id),
      displayName: displayNameFromPath(status.path),
    },
    path: status.path,
    formatVersion: CURRENT_LIBRARY_FORMAT_VERSION,
  };
}

function Welcome({
  onChoose,
}: {
  onChoose: (purpose: Extract<LibraryPickerPurpose, "create" | "open">) => void;
}): ReactNode {
  return (
    <main className={styles.welcome}>
      <section className={styles.welcomeCopy}>
        <div className={styles.wordmark} translate="no">
          <img
            src={brandMark}
            width="38"
            height="38"
            alt=""
            aria-hidden="true"
            fetchPriority="high"
          />
          <span>Vistash</span>
        </div>
        <p className={styles.eyebrow}>LOCAL VISUAL ARCHIVE</p>
        <h1>本地视觉档案</h1>
        <p className={styles.lead}>把散落在电脑里的图片集中整理成一个可迁移、可重建的本地库。</p>
        <ul className={styles.promises}>
          <li>图片会复制进库</li>
          <li>库会占用磁盘空间</li>
          <li>源文件不会被修改</li>
        </ul>
        <div className={styles.actions}>
          <Button variant="primary" startIcon={<PlusIcon />} onClick={() => onChoose("create")}>
            创建新库
          </Button>
          <Button startIcon={<FolderOpenIcon />} onClick={() => onChoose("open")}>
            打开已有库
          </Button>
        </div>
      </section>
      <aside className={styles.welcomeMark} aria-hidden="true">
        <ArchiveIcon />
        <span>素材与可读元数据保存在你选择的位置</span>
      </aside>
    </main>
  );
}

function FailureView({
  error,
  onChoose,
  onMigrate,
  path,
}: {
  error: AppError;
  onChoose: (purpose: Extract<LibraryPickerPurpose, "open" | "relocate">) => void;
  onMigrate?: () => void;
  path: string | null;
}): ReactNode {
  const needsMigration = error.code === "library.format_too_old";
  return (
    <main className={styles.failurePage}>
      <section className={styles.failureCard}>
        <WarningIcon className={styles.failureIcon} aria-hidden="true" />
        <p className={styles.eyebrow}>{needsMigration ? "LIBRARY MIGRATION" : "LIBRARY UNAVAILABLE"}</p>
        <h1>{needsMigration ? "这个库需要升级" : "无法打开上次的库"}</h1>
        {path === null ? null : <p className={styles.path}>{path}</p>}
        <p className={styles.error} role="alert">{formatError(error)}</p>
        <div className={styles.actions}>
          {needsMigration && path !== null && onMigrate !== undefined ? (
            <ConfirmDialog
              trigger={<Button variant="primary">准备迁移</Button>}
              title="准备升级库格式？"
              description="Vistash 会先备份旧元数据并生成迁移方案。多归属图片仍需逐项选择唯一文件夹。"
              confirmLabel="检查迁移方案"
              onConfirm={onMigrate}
            />
          ) : null}
          {path === null ? null : (
            <Button
              variant={needsMigration ? "secondary" : "primary"}
              onClick={() => onChoose("relocate")}
            >
              重新定位该库
            </Button>
          )}
          <Button onClick={() => onChoose("open")}>打开其他库</Button>
        </div>
      </section>
    </main>
  );
}

function MigrationProgressView({
  committing,
  progress,
}: {
  committing: boolean;
  progress: MigrationProgress | null;
}): ReactNode {
  const label = committing ? "正在提交库格式迁移" : "正在准备迁移方案";
  return (
    <main className={styles.migrationProgressPage}>
      <section className={styles.migrationProgressCard}>
        <p className={styles.eyebrow}>LIBRARY MIGRATION</p>
        <h1>{label}</h1>
        <p>
          {committing
            ? "正在替换权威元数据并重建索引，此阶段不能取消。"
            : "正在备份旧元数据并扫描图片文件夹归属。"}
        </p>
        <Progress
          label={label}
          value={progress === null || progress.total === 0 ? null : progress.done}
          {...(progress === null || progress.total === 0 ? {} : { max: progress.total })}
        />
        {progress === null || progress.current_filename.length === 0 ? null : (
          <p className={styles.currentFile}>{progress.current_filename}</p>
        )}
      </section>
    </main>
  );
}

function MigrationPlanView({
  onCancel,
  onCommit,
  onSelect,
  plan,
  resolutions,
}: {
  onCancel: () => void;
  onCommit: () => void;
  onSelect: (hash: string, folder: string) => void;
  plan: V3MigrationPlan;
  resolutions: ReadonlyMap<string, string>;
}): ReactNode {
  const conflicts = plan.entries.filter(
    (entry): entry is V3ConflictEntry => entry.kind === "conflict",
  );
  const automaticCount = plan.entries.length - conflicts.length;
  const complete = resolutions.size === conflicts.length;
  return (
    <main className={styles.migrationPage}>
      <header className={styles.migrationHeader}>
        <div>
          <p className={styles.eyebrow}>FOLDER RESOLUTION</p>
          <h1>选择唯一图片文件夹</h1>
          <p>
            {NUMBER_FORMAT.format(automaticCount)} 张图片可自动迁移，{NUMBER_FORMAT.format(conflicts.length)} 张图片需要选择。
          </p>
        </div>
        <Button variant="ghost" onClick={onCancel}>退出迁移</Button>
      </header>
      <div className={styles.conflictList}>
        {conflicts.length === 0 ? (
          <p className={styles.noConflicts}>没有多归属冲突，可以直接确认迁移。</p>
        ) : (
          conflicts.map((entry) => (
            <fieldset key={entry.hash} className={styles.conflict}>
              <legend>{entry.original_filename}</legend>
              <p>选择迁移后保留的唯一图片文件夹</p>
              <div className={styles.candidates}>
                {entry.candidates.map((folder) => (
                  <label key={folder}>
                    <input
                      type="radio"
                      name={`migration-${entry.hash}`}
                      value={folder}
                      checked={resolutions.get(entry.hash) === folder}
                      onChange={() => onSelect(entry.hash, folder)}
                    />
                    <span>{folder}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))
        )}
      </div>
      <footer className={styles.migrationFooter}>
        <span>{NUMBER_FORMAT.format(resolutions.size)}/{NUMBER_FORMAT.format(conflicts.length)} 项冲突已选择</span>
        <ConfirmDialog
          trigger={<Button variant="primary" disabled={!complete}>确认迁移</Button>}
          title="提交库格式迁移？"
          description="提交后会替换权威元数据并重建索引。失败时 Vistash 会按恢复日志整体回滚。"
          confirmLabel="开始迁移"
          onConfirm={onCommit}
        />
      </footer>
    </main>
  );
}

export function LibraryLifecycle({
  children,
  port,
}: {
  port: LibraryLifecyclePort;
  children?: (context: OpenLibraryContext) => ReactNode;
}): ReactNode {
  const [localStatus, setLocalStatus] = useState<LibraryStatus | null>(null);
  const [operation, setOperation] = useState<OperationState>({ kind: "idle" });
  const status = useQuery({
    queryKey: LIBRARY_STATUS_KEY,
    queryFn: () => port.status(),
    retry: false,
  });

  const chooseLibrary = async (purpose: LibraryPickerPurpose): Promise<void> => {
    setOperation({ kind: "busy", label: purpose === "create" ? "正在创建本地库…" : "正在打开本地库…" });
    let path: string | null = null;
    try {
      path = await port.pickLibraryDirectory(purpose);
      if (path === null) {
        setOperation({ kind: "idle" });
        return;
      }
      const next = await port.open(path);
      setLocalStatus(next);
      setOperation({ kind: "idle" });
    } catch (raw) {
      setOperation({ kind: "failure", path, error: asAppError(raw) });
    }
  };

  const startMigration = async (path: string): Promise<void> => {
    setOperation({ kind: "preparing", path, progress: null });
    try {
      await port.migrateLegacy(path, (progress) => {
        setOperation({ kind: "preparing", path, progress });
      });
      const plan = await port.planV3(path);
      setOperation({ kind: "planning", path, plan, resolutions: new Map() });
    } catch (raw) {
      setOperation({ kind: "failure", path, error: asAppError(raw) });
    }
  };

  const selectResolution = (hash: string, folder: string): void => {
    setOperation((current) => {
      if (current.kind !== "planning") {
        throw new Error(`只有 planning 状态能选择迁移文件夹，当前是 ${current.kind}`);
      }
      const resolutions = new Map(current.resolutions);
      resolutions.set(hash, folder);
      return { ...current, resolutions };
    });
  };

  const commitMigration = async (): Promise<void> => {
    if (operation.kind !== "planning") {
      throw new Error(`只有 planning 状态能提交迁移，当前是 ${operation.kind}`);
    }
    const conflicts = operation.plan.entries.filter(
      (entry): entry is V3ConflictEntry => entry.kind === "conflict",
    );
    const resolutions: V3FolderResolutionInput[] = conflicts.map((entry) => {
      const folder = operation.resolutions.get(entry.hash);
      if (folder === undefined) throw new Error(`迁移冲突尚未选择：${entry.hash}`);
      return { hash: entry.hash, folder };
    });
    const path = operation.path;
    setOperation({ kind: "committing", path, progress: null });
    try {
      const next = await port.commitV3(path, resolutions, (progress) => {
        setOperation({ kind: "committing", path, progress });
      });
      setLocalStatus(next);
      setOperation({ kind: "idle" });
    } catch (raw) {
      setOperation({ kind: "failure", path, error: asAppError(raw) });
    }
  };

  if (status.isPending) return <main><p role="status">正在恢复上次的库…</p></main>;
  if (status.isError) {
    return (
      <FailureView
        error={asAppError(status.error)}
        path={null}
        onChoose={(purpose) => void chooseLibrary(purpose)}
      />
    );
  }
  if (operation.kind === "busy") return <main className={styles.centered}><p role="status">{operation.label}</p></main>;
  if (operation.kind === "preparing") {
    return <MigrationProgressView committing={false} progress={operation.progress} />;
  }
  if (operation.kind === "committing") {
    return <MigrationProgressView committing progress={operation.progress} />;
  }
  if (operation.kind === "planning") {
    return (
      <MigrationPlanView
        plan={operation.plan}
        resolutions={operation.resolutions}
        onSelect={selectResolution}
        onCancel={() => setOperation({ kind: "idle" })}
        onCommit={() => void commitMigration()}
      />
    );
  }
  if (operation.kind === "failure") {
    if (operation.error.code === "library.format_too_old" && operation.path !== null) {
      const migrationPath = operation.path;
      return (
        <FailureView
          error={operation.error}
          path={migrationPath}
          onChoose={(purpose) => void chooseLibrary(purpose)}
          onMigrate={() => void startMigration(migrationPath)}
        />
      );
    }
    return (
      <FailureView
        error={operation.error}
        path={operation.path}
        onChoose={(purpose) => void chooseLibrary(purpose)}
      />
    );
  }
  const effectiveStatus = localStatus ?? status.data;
  const context = compatibleContext(effectiveStatus);
  if (context !== null) {
    if (children === undefined) throw new Error("LibraryLifecycle 缺少工作现场 render prop");
    return children(context);
  }
  if (effectiveStatus.problem === null && effectiveStatus.recorded_path === null) {
    return <Welcome onChoose={(purpose) => void chooseLibrary(purpose)} />;
  }
  if (effectiveStatus.problem === null) throw new Error("未打开库状态缺少失败原因");
  if (
    effectiveStatus.problem.code === "library.format_too_old" &&
    effectiveStatus.recorded_path !== null
  ) {
    const migrationPath = effectiveStatus.recorded_path;
    return (
      <FailureView
        error={effectiveStatus.problem}
        path={migrationPath}
        onChoose={(purpose) => void chooseLibrary(purpose)}
        onMigrate={() => void startMigration(migrationPath)}
      />
    );
  }
  return (
    <FailureView
      error={effectiveStatus.problem}
      path={effectiveStatus.recorded_path}
      onChoose={(purpose) => void chooseLibrary(purpose)}
    />
  );
}
