/**
 * 全局任务中心的应用级 seam（任务 6.1，设计第三条与第十三条）。
 *
 * `TaskCenter` 只聚合长任务的可见状态，不拥有任何业务事务：导入、导出、迁移
 * 与批量组织的回滚、重试和缓存失效都由各自的协调器负责。本文件定义任务记录
 * 的封闭类型与 store 的窄 interface；store 实现、节流与保留规则在任务 6.3 落地。
 *
 * 两条规格红线在这里被类型与合同钉死：
 * - 只有后端确认后才进入 `stopped`——唯一能写入 stopped 的入口是
 *   [`TaskCenter.confirmStopped`]，前端隐藏进度不算已停止。
 * - 报告永远逐项携带失败明细（显示名 + 稳定错误码），不存在"只报失败总数"
 *   的形状。
 */

import type { AppError } from "../shared/types";
import type { Unsubscribe } from "./common";

/** 长任务种类。封闭联合：聚合面板按种类呈现图标与标题模板，新增种类必须显式扩展。 */
export type TaskKind =
  | "import"
  | "export"
  | "migration"
  | "folder_mutation"
  | "batch_organization";

/**
 * 任务运行状态。恰好六种：running / stopping / stopped / succeeded / partial / failed。
 *
 * `stopping` 表示使用者已请求停止但后端尚未确认；`stopped` 只能由后端确认写入。
 */
export type TaskRunState =
  | "running"
  | "stopping"
  | "stopped"
  | "succeeded"
  | "partial"
  | "failed";

/** 终态：不会再变化的运行状态。 */
export type TaskFinalState = Extract<
  TaskRunState,
  "stopped" | "succeeded" | "partial" | "failed"
>;

/** 任务中心的任务标识，值由 [`TaskCenter.register`] 的实现分配。 */
export type TaskId = string;

/**
 * 库级传输并发键：同一键的任务在同一个库上不得重叠运行。
 *
 * 模板字面量类型让任意字符串无法冒充并发键——键只能经
 * [`createLibraryTransferKey`] 构造，并与后端的库级锁共用同一个字面值。
 */
export type LibraryTransferKey = `library:${string}:transfer`;

/** 由库标识构造传输并发键。导入与导出共用同一把库级键（后端 import_stop 同源）。 */
export function createLibraryTransferKey(libraryId: string): LibraryTransferKey {
  return `library:${libraryId}:transfer`;
}

/**
 * 节流前的进度输入。按任务种类区分三种形状，字段与后端 DTO 一一对应，
 * 由各协调器在自己的观察点完成 DTO 到此处的映射；store 负责按帧节流呈现。
 */
export type TaskProgress =
  | { kind: "transfer"; done: number; total: number; currentFilename: string | null }
  | { kind: "migration"; stage: string; done: number; total: number; currentFilename: string }
  | { kind: "items"; done: number; total: number };

/** 一条逐项失败：目标显示名 + 稳定错误码。 */
export type TaskFailureItem = {
  displayName: string;
  error: AppError;
};

/** 完成报告的四桶计数，命名对齐规格用语。 */
export type TaskOutcomeCounts = {
  /** 成功处理的项数：导入素材数、导出文件数或成功的批量项数。 */
  succeeded: number;
  /** 因内容已在库内、非图片或同名冲突决议而未写入的项数。 */
  skipped: number;
  /** 逐项失败的项数；明细见 [`TaskOutcome.failures`]。 */
  failed: number;
  /** 观察到停止后尚未处理的项数；这不是失败。 */
  unprocessed: number;
};

/** 可读的跳过原因；不同业务协调器只填自己拥有的原因。 */
export type TaskSkipDetail = {
  kind: "duplicate" | "unsupported" | "conflict";
  count: number;
};

/** 任务完成报告。部分成功是常态，因此失败明细永远逐项携带。 */
export type TaskOutcome = {
  counts: TaskOutcomeCounts;
  failures: TaskFailureItem[];
  /** 导入/导出的跳过拆分；没有该业务维度的任务保持未定义。 */
  skipDetails?: readonly TaskSkipDetail[];
  /** 任务级整体失败（如迁移整体回滚）；只在逐项失败解释不了时使用。 */
  error: AppError | null;
};

/**
 * 从完成报告推导最终状态：有整体错误即 failed；没有逐项失败即 succeeded；
 * 失败与成功并存即 partial，全部失败也是 failed。
 */
export function deriveTaskFinalState(outcome: TaskOutcome): "succeeded" | "partial" | "failed" {
  if (outcome.error !== null) return "failed";
  if (outcome.counts.failed === 0) return "succeeded";
  return outcome.counts.succeeded > 0 ? "partial" : "failed";
}

/** 注册一个任务的输入。任务 ID 由 store 分配——调用方不需要也不会提供。 */
export type TaskRegistrationInput = {
  kind: TaskKind;
  /** 稳定标题（中文文案由调用方给出），聚合列表直接显示。 */
  title: string;
  /** 库作用域：任务属于哪个打开的库。 */
  libraryId: string;
  /**
   * 是否允许使用者请求停止。导入与导出为 true；普通批量组织在本变更中必须为
   * false——不允许冒充可取消任务；迁移进入权威写入阶段后同样为 false。
   */
  stoppable: boolean;
  /** 需要独占的库级并发键；null 表示该任务不声明独占（如批量组织）。 */
  concurrencyKey: LibraryTransferKey | null;
};

/** 一条任务在任务中心里的完整记录。进度由 store 节流后呈现；字段语义只增不改。 */
export type TaskRecord = {
  id: TaskId;
  kind: TaskKind;
  title: string;
  libraryId: string;
  stoppable: boolean;
  concurrencyKey: LibraryTransferKey | null;
  state: TaskRunState;
  startedAt: string;
  finishedAt: string | null;
  progress: TaskProgress | null;
  outcome: TaskOutcome | null;
};

/** 注册结果：重叠注册不抛错也不静默合并，而是指向正在运行的同一任务。 */
export type TaskRegistrationResult =
  | { kind: "registered"; record: TaskRecord }
  | { kind: "rejected_by_concurrency"; conflictingTaskId: TaskId };

/**
 * 任务中心 store 的窄 interface（实现见任务 6.3）。
 *
 * 所有方法都是明确动作，没有字符串主题；界面经 [`TaskCenter.subscribe`] 的
 * 无参信号加快照拉取接入 React。以下不变量实现 MUST 保证，违规一律抛错而不是
 * 静默吞掉——那属于不变量错误，不是业务 fallback：
 *
 * - 并发键相同的运行中任务只能有一个；重叠注册返回 `rejected_by_concurrency`
 *   并指向当前任务。
 * - [`TaskCenter.markStopRequested`] 仅接受 running 且 stoppable 的记录（进入
 *   stopping）。
 * - [`TaskCenter.confirmStopped`] 仅接受 stopping 的记录——这是唯一能写入
 *   stopped 的入口，"只有后端确认后才算停止"由此在结构上成立。
 * - [`TaskCenter.complete`] 接受 running 或 stopping（停止请求与最后一项完成
 *   竞速时以真实结果为准），最终状态按 [`deriveTaskFinalState`] 从报告推导。
 * - [`TaskCenter.dismiss`] 仅接受终态记录；关闭运行中任务的详情面板不是
 *   dismiss，也绝不会经由本 interface 停止任务。
 * - 成功且无需进一步处理的记录可在查看后移除（见 [`isCleanSuccess`]）；
 *   含失败、部分成功或停止结果的记录保留到使用者明确调用 dismiss。
 */
export interface TaskCenter {
  register(input: TaskRegistrationInput): TaskRegistrationResult;
  reportProgress(taskId: TaskId, progress: TaskProgress): void;
  markStopRequested(taskId: TaskId): void;
  confirmStopped(taskId: TaskId, outcome: TaskOutcome): void;
  complete(taskId: TaskId, outcome: TaskOutcome): void;
  dismiss(taskId: TaskId): void;
  snapshot(): readonly TaskRecord[];
  subscribe(listener: () => void): Unsubscribe;
}

/**
 * 该终态记录是否"成功且无需进一步处理"，可在使用者查看后自动移除。
 * 只要携带任何失败明细、任务级错误或未处理项，就必须保留到使用者明确关闭；
 * 重复或冲突跳过只是信息量差异，不阻止移除。
 */
export function isCleanSuccess(record: Pick<TaskRecord, "state" | "outcome">): boolean {
  if (record.state !== "succeeded" || record.outcome === null) return false;
  const outcome = record.outcome;
  return (
    outcome.failures.length === 0 &&
    outcome.error === null &&
    outcome.counts.unprocessed === 0
  );
}
