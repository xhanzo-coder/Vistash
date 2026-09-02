import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { ImagesIcon } from "@phosphor-icons/react/dist/csr/Images";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { asAppError, formatError } from "../../../shared/errors";
import { appTaskCenter } from "../../../app/runtime";
import type { AppError, LibraryStatus } from "../../../shared/types";
import { parseLibraryId } from "../../../app/common";
import { Button } from "../../../ui/button/Button";
import { ConfirmDialog } from "../../../ui/dialog/Dialog";
import { Progress } from "../../../ui/progress/Progress";
import { WindowControls } from "../../../app/shell/WindowControls";
import brandMark from "../../../assets/brand/vistash-mark.svg";
import sampleDunes from "../../../assets/welcome/sample-dunes.jpg";
import sampleForest from "../../../assets/welcome/sample-forest.jpg";
import sampleSea from "../../../assets/welcome/sample-sea.jpg";
import type {
  MigrationProgress,
  V3FolderResolutionInput,
  V3MigrationPlan,
  V3MigrationPlanEntry,
} from "../../../shared/types";
import type {
  LibraryPickerPurpose,
  LibraryLifecyclePort,
  LibraryLifecycleControls,
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

function LifecycleWindowFrame({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className={styles.windowFrame}>
      <header className={styles.windowBar} data-tauri-drag-region>
        <div className={styles.windowBrand} data-tauri-drag-region translate="no">
          <img src={brandMark} width="24" height="24" alt="" aria-hidden="true" />
          <span>Vistash</span>
        </div>
        <div className={styles.windowDragRegion} data-tauri-drag-region aria-hidden="true" />
        <WindowControls />
      </header>
      <div className={styles.windowContent}>{children}</div>
    </div>
  );
}

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
    <LifecycleWindowFrame><main className={styles.welcome}>
      <section className={styles.welcomeCopy}>
        <div className={styles.wordmark} translate="no">
          <img
            src={brandMark}
            width="34"
            height="34"
            alt=""
            aria-hidden="true"
            fetchPriority="high"
          />
          <span>Vistash</span>
        </div>
        <p className={styles.eyebrow}>LOCAL VISUAL ARCHIVE</p>
        <h1>把散落的图片，收进<span className={styles.headlineAccent}>一座库</span>。</h1>
        <p className={styles.lead}>
          选一个文件夹作为库的位置。素材会被复制进去并建立索引，库可以整体搬走、随时重建，源文件始终保持原样。
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            aria-label="创建新库"
            className={`${styles.actionCard} ${styles.actionPrimary}`}
            onClick={() => onChoose("create")}
          >
            <span className={styles.actionIcon}><PlusIcon aria-hidden="true" /></span>
            <span className={styles.actionTitle}>
              创建新库
              <ArrowRightIcon className={styles.actionArrow} aria-hidden="true" />
            </span>
            <span className={styles.actionDesc}>选一个空文件夹，从零开始建立你的视觉档案。</span>
          </button>
          <button
            type="button"
            aria-label="打开已有库"
            className={styles.actionCard}
            onClick={() => onChoose("open")}
          >
            <span className={styles.actionIcon}><FolderOpenIcon aria-hidden="true" /></span>
            <span className={styles.actionTitle}>
              打开已有库
              <ArrowRightIcon className={styles.actionArrow} aria-hidden="true" />
            </span>
            <span className={styles.actionDesc}>指向已有的 Vistash 库目录，直接继续工作。</span>
          </button>
        </div>
        <ul className={styles.promises}>
          <li><CheckIcon aria-hidden="true" />图片会复制进库，源文件不会被修改</li>
          <li><CheckIcon aria-hidden="true" />库会占用磁盘空间，请留足余量</li>
          <li><CheckIcon aria-hidden="true" />库可整体迁移、随时重建</li>
        </ul>
      </section>
      <aside className={styles.welcomeVisual} aria-hidden="true">
        <div className={styles.visualStage}>
          <div className={styles.stack}>
            <figure className={`${styles.photo} ${styles.photoBack}`}>
              <div className={styles.photoImg}><img src={sampleForest} alt="" loading="lazy" /></div>
              <figcaption className={styles.photoCaption}><span>IMG_2041</span><span>RAW</span></figcaption>
            </figure>
            <figure className={`${styles.photo} ${styles.photoMid}`}>
              <div className={styles.photoImg}><img src={sampleSea} alt="" loading="lazy" /></div>
              <figcaption className={styles.photoCaption}><span>SCAN_0073</span><span>TIFF</span></figcaption>
            </figure>
            <figure className={`${styles.photo} ${styles.photoFront}`}>
              <div className={styles.photoImg}><img src={sampleDunes} alt="" loading="lazy" /></div>
              <figcaption className={styles.photoCaption}><span>DSCF_1892</span><span>JPEG</span></figcaption>
            </figure>
          </div>
          <span className={`${styles.chip} ${styles.chipTop}`}>
            <ImagesIcon aria-hidden="true" />
            <span><strong>1,248</strong> 张素材已索引</span>
          </span>
          <span className={`${styles.chip} ${styles.chipBottom}`}>
            <ShieldCheckIcon aria-hidden="true" />
            <span>元数据可读，永不锁定</span>
          </span>
        </div>
        <p className={styles.visualCaption}>素材与元数据保存在你选择的位置</p>
      </aside>
    </main></LifecycleWindowFrame>
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
    <LifecycleWindowFrame><main className={styles.failurePage}>
      <section className={styles.failureCard}>
        <WarningIcon className={styles.failureIcon} aria-hidden="true" />
        <p className={styles.eyebrow}>{needsMigration ? "LIBRARY MIGRATION" : "LIBRARY UNAVAILABLE"}</p>
        <h1>{needsMigration ? "这个库需要升级" : "无法打开上次的库"}</h1>
        {path === null ? null : <p className={styles.path}>{path}</p>}
        <p className={styles.error} role="alert" data-error-code={error.code}>{formatError(error)}</p>
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
    </main></LifecycleWindowFrame>
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
    <LifecycleWindowFrame><main className={styles.migrationProgressPage}>
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
    </main></LifecycleWindowFrame>
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
    <LifecycleWindowFrame><main className={styles.migrationPage}>
      <header className={styles.migrationHeader}>
        <div>
          <p className={styles.eyebrow}>FOLDER RESOLUTION</p>
          <h1>选择唯一图片文件夹</h1>
          <p>
            {NUMBER_FORMAT.format(automaticCount)} 张图片可自动迁移，{NUMBER_FORMAT.format(conflicts.length)} 张图片需要选择。
          </p>
        </div>
        <div className={styles.migrationHeaderActions}>
          <Button variant="ghost" onClick={onCancel}>退出迁移</Button>
        </div>
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
    </main></LifecycleWindowFrame>
  );
}

export function LibraryLifecycle({
  children,
  port,
}: {
  port: LibraryLifecyclePort;
  children?: (context: OpenLibraryContext, controls: LibraryLifecycleControls) => ReactNode;
}): ReactNode {
  const [localStatus, setLocalStatus] = useState<LibraryStatus | null>(null);
  const [operation, setOperation] = useState<OperationState>({ kind: "idle" });
  const migrationTaskId = useRef<string | null>(null);
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
    if (migrationTaskId.current !== null) throw new Error("迁移任务已经在运行");
    const registration = appTaskCenter.register({ kind: "migration", title: "准备迁移方案", libraryId: path, stoppable: false, concurrencyKey: null });
    if (registration.kind !== "registered") throw new Error("迁移任务意外触发并发拒绝");
    migrationTaskId.current = registration.record.id;
    setOperation({ kind: "preparing", path, progress: null });
    try {
      await port.migrateLegacy(path, (progress) => {
        appTaskCenter.reportProgress(registration.record.id, { kind: "migration", stage: progress.stage, done: progress.done, total: progress.total, currentFilename: progress.current_filename });
        setOperation({ kind: "preparing", path, progress });
      });
      const plan = await port.planV3(path);
      appTaskCenter.complete(registration.record.id, { counts: { succeeded: 1, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: null });
      migrationTaskId.current = null;
      setOperation({ kind: "planning", path, plan, resolutions: new Map() });
    } catch (raw) {
      const error = asAppError(raw);
      appTaskCenter.complete(registration.record.id, { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error });
      migrationTaskId.current = null;
      setOperation({ kind: "failure", path, error });
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
    if (migrationTaskId.current !== null) throw new Error("迁移任务已经在运行");
    const registration = appTaskCenter.register({ kind: "migration", title: "提交库格式迁移", libraryId: path, stoppable: false, concurrencyKey: null });
    if (registration.kind !== "registered") throw new Error("迁移任务意外触发并发拒绝");
    migrationTaskId.current = registration.record.id;
    setOperation({ kind: "committing", path, progress: null });
    try {
      const next = await port.commitV3(path, resolutions, (progress) => {
        appTaskCenter.reportProgress(registration.record.id, { kind: "migration", stage: progress.stage, done: progress.done, total: progress.total, currentFilename: progress.current_filename });
        setOperation({ kind: "committing", path, progress });
      });
      appTaskCenter.complete(registration.record.id, { counts: { succeeded: 1, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: null });
      migrationTaskId.current = null;
      setLocalStatus(next);
      setOperation({ kind: "idle" });
    } catch (raw) {
      const error = asAppError(raw);
      appTaskCenter.complete(registration.record.id, { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error });
      migrationTaskId.current = null;
      setOperation({ kind: "failure", path, error });
    }
  };

  if (status.isPending) return <LifecycleWindowFrame><main><p role="status">正在恢复上次的库…</p></main></LifecycleWindowFrame>;
  if (status.isError) {
    return (
      <FailureView
        error={asAppError(status.error)}
        path={null}
        onChoose={(purpose) => void chooseLibrary(purpose)}
      />
    );
  }
  if (operation.kind === "busy") return <LifecycleWindowFrame><main className={styles.centered}><p role="status">{operation.label}</p></main></LifecycleWindowFrame>;
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
    return children(context, {
      createNewLibrary: () => void chooseLibrary("create"),
      openOtherLibrary: () => void chooseLibrary("open"),
    });
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
