import { useEffect, useState, type ReactNode } from "react";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button, IconButton } from "../../ui/button/Button";
import { Popover } from "../../ui/overlays/Popover";
import { Progress } from "../../ui/progress/Progress";
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

function TaskItem({ record, taskCenter }: { record: TaskRecord; taskCenter: TaskCenter }): ReactNode {
  const terminal = record.state !== "running" && record.state !== "stopping";
  return (
    <article className={styles.task} data-state={record.state}>
      <header>
        <div>
          <strong>{record.title}</strong>
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
        <p className={styles.outcome}>
          成功 {NUMBER_FORMAT.format(record.outcome.counts.succeeded)}，跳过 {NUMBER_FORMAT.format(record.outcome.counts.skipped)}，失败 {NUMBER_FORMAT.format(record.outcome.counts.failed)}，未处理 {NUMBER_FORMAT.format(record.outcome.counts.unprocessed)}
        </p>
      )}
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

export function TaskCenterPopover({ taskCenter }: { taskCenter: TaskCenter }): ReactNode {
  const records = useTaskRecords(taskCenter);
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
            {records.map((record) => <TaskItem key={record.id} record={record} taskCenter={taskCenter} />)}
          </div>
        )}
      </div>
    </Popover>
  );
}
