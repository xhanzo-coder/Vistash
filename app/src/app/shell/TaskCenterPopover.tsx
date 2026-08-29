import { useEffect, useState, type ReactNode } from "react";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button, IconButton } from "../../ui/button/Button";
import { Popover } from "../../ui/overlays/Popover";
import { Progress } from "../../ui/progress/Progress";
import { IpcError, formatError } from "../../shared/errors";
import type { AppError } from "../../shared/types";
import type { TaskCenter, TaskRecord, TaskRunState } from "../taskCenter";
import styles from "./TaskCenterPopover.module.css";

const NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");

function stateLabel(state: TaskRunState): string {
  switch (state) {
    case "running":
      return "运行中";
    case "stopping":
      return "正在停止";
    case "stopped":
      return "已停止";
    case "succeeded":
      return "已完成";
    case "partial":
      return "部分完成";
    case "failed":
      return "失败";
  }
  throw new Error(`未知任务状态：${String(state)}`);
}

function taskKindLabel(kind: TaskRecord["kind"]): string {
  switch (kind) {
    case "import":
      return "导入";
    case "export":
      return "导出";
    case "migration":
      return "库迁移";
    case "folder_mutation":
      return "文件夹";
    case "batch_organization":
      return "批量组织";
  }
  throw new Error(`未知任务种类：${String(kind)}`);
}

function taskProgress(record: TaskRecord): ReactNode {
  if (record.progress === null) return null;
  const { done, total } = record.progress;
  const currentFilename =
    record.progress.kind === "items" ? null : record.progress.currentFilename;
  return (
    <div className={styles.progressBlock}>
      <Progress
        compact
        label={`${record.title} ${NUMBER_FORMAT.format(done)}/${NUMBER_FORMAT.format(total)}`}
        value={total === 0 ? null : done}
        {...(total === 0 ? {} : { max: total })}
      />
      {currentFilename === null ? null : <p>{currentFilename}</p>}
    </div>
  );
}

function TaskItem({ record, taskCenter, onStopTask, canStopTask, stopError }: { record: TaskRecord; taskCenter: TaskCenter; onStopTask?: (taskId: string) => Promise<void>; canStopTask?: (taskId: string) => boolean; stopError: string | null }): ReactNode {
  const terminal = record.state !== "running" && record.state !== "stopping";
  return (
    <article className={styles.task} data-state={record.state} data-task-id={record.id}>
      <header>
        <div>
          <strong>{record.title}</strong>
          <span data-task-kind={record.kind}>{taskKindLabel(record.kind)}</span>
          <span>{stateLabel(record.state)}</span>
        </div>
        {terminal ? (
          <IconButton
            size="compact"
            label={`关闭任务记录：${record.title}`}
            icon={<XIcon />}
            onClick={() => taskCenter.dismiss(record.id)}
          />
        ) : null}
      </header>
      {taskProgress(record)}
      {record.outcome === null ? null : (
        <>
          <p className={styles.outcome}>
            成功 {NUMBER_FORMAT.format(record.outcome.counts.succeeded)}，跳过 {NUMBER_FORMAT.format(record.outcome.counts.skipped)}，失败 {NUMBER_FORMAT.format(record.outcome.counts.failed)}，未处理 {NUMBER_FORMAT.format(record.outcome.counts.unprocessed)}
          </p>
          {record.outcome.skipDetails?.map((detail) => (
            <p key={`${record.id}-${detail.kind}`}>
              跳过：{detail.kind === "unsupported" ? "非图片" : detail.kind === "duplicate" ? "重复内容" : "同名冲突"} {NUMBER_FORMAT.format(detail.count)} 项
            </p>
          ))}
          {record.outcome.error === null && record.outcome.failures.length === 0 ? null : (
            <details>
              <summary>查看逐项结果</summary>
              {record.outcome.error === null ? null : <p role="alert">{formatError(record.outcome.error)}</p>}
              {record.outcome.failures.map((failure) => (
                <p key={`${record.id}-${failure.displayName}`} role="alert">
                  {failure.displayName}：{formatError(failure.error)}
                </p>
              ))}
            </details>
          )}
        </>
      )}
      {!terminal && record.stoppable && onStopTask !== undefined && (canStopTask === undefined || canStopTask(record.id)) ? (
        <Button
          size="compact"
          aria-label={`${record.state === "stopping" ? "重试停止" : "停止"}任务：${record.title}`}
          onClick={() => {
            void onStopTask(record.id);
          }}
        >
          {record.state === "stopping" ? "正在停止…" : "停止"}
        </Button>
      ) : null}
      {stopError === null ? null : <p role="alert">{stopError}</p>}
    </article>
  );
}

function useTaskRecords(taskCenter: TaskCenter): readonly TaskRecord[] {
  const [records, setRecords] = useState<readonly TaskRecord[]>(() => taskCenter.snapshot());
  useEffect(
    () => taskCenter.subscribe(() => setRecords(taskCenter.snapshot())),
    [taskCenter],
  );
  return records;
}

export function TaskCenterPopover({ taskCenter, onStopTask, canStopTask, getStopError }: { taskCenter: TaskCenter; onStopTask?: (taskId: string) => Promise<void>; canStopTask?: (taskId: string) => boolean; getStopError?: (taskId: string) => AppError | null }): ReactNode {
  const records = useTaskRecords(taskCenter);
  const [stopError, setStopError] = useState<{ taskId: string; message: string } | null>(null);
  const requestStop = (taskId: string): Promise<void> => {
    if (onStopTask === undefined) throw new Error("任务中心未配置传输停止协调器");
    return onStopTask(taskId).then(
      () => setStopError(null),
      (raw: unknown) => {
        if (!(raw instanceof IpcError)) throw raw;
        setStopError({ taskId, message: formatError(raw.appError) });
      },
    );
  };
  const runningCount = records.filter(
    (record) => record.state === "running" || record.state === "stopping",
  ).length;
  const formattedRunningCount = NUMBER_FORMAT.format(runningCount);
  const label = `任务中心，${formattedRunningCount} 个运行中`;

  return (
    <Popover
      align="end"
      label="任务中心"
      trigger={
        <Button
          aria-label={label}
          variant="ghost"
          startIcon={<ListChecksIcon />}
        >
          任务{runningCount === 0 ? null : <span className={styles.count}>{formattedRunningCount}</span>}
        </Button>
      }
    >
      <div className={styles.root} data-ui="task-center">
        <header className={styles.heading}>
          <div><strong>任务中心</strong><span>{formattedRunningCount} 个运行中</span></div>
        </header>
        {records.length === 0 ? (
          <p className={styles.empty}>当前没有任务。</p>
        ) : (
          <div className={styles.list}>
            {records.map((record) => {
              const reportedStopError = getStopError?.(record.id);
              return <TaskItem key={record.id} record={record} taskCenter={taskCenter} {...(onStopTask === undefined ? {} : { onStopTask: requestStop })} {...(canStopTask === undefined ? {} : { canStopTask })} stopError={stopError?.taskId === record.id ? stopError.message : reportedStopError === null || reportedStopError === undefined ? null : formatError(reportedStopError)} />;
            })}
          </div>
        )}
      </div>
    </Popover>
  );
}
