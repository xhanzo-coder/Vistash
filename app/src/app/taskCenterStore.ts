/**
 * [`TaskCenter`] 的唯一 store 实现。
 *
 * 纯 TypeScript 闭包工厂，不依赖任何框架：界面经 `subscribe` 的无参信号加
 * `snapshot` 拉取接入 React（`useSyncExternalStore`）。这里只做聚合与不变量
 * 执法——回滚、重试、缓存失效仍归各协调器。
 *
 * 三条行为约束在本文件的落点：
 * - 并发键：同键非终态任务唯一，重叠注册返回指向当前任务的拒绝结果。
 * - 真实停止确认：[`confirmStopped`] 是唯一能把记录写成 `stopped` 的入口，
 *   且仅接受 `stopping`——前端隐藏进度永远不算已停止。
 * - 保留规则：store 从不自动移除任何记录；dismiss 仅接受终态，关闭运行中
 *   详情面板绝不经由本接口发生。"可查看后移除"的判定由 [`isCleanSuccess`]
 *   提供给界面层。
 *
 * 节流语义：进度事实永远即时最新（`snapshot` 不说谎），被合并的只是订阅者
 * 通知——同一窗口内的多次进度合并为一次尾随通知。状态转换（注册、停止、
 * 完成、移除）始终立即通知并取消未决的尾随计时器。
 */

import { deriveTaskFinalState } from "./taskCenter";
import type { Unsubscribe } from "./common";
import type {
  LibraryTransferKey,
  TaskCenter,
  TaskFinalState,
  TaskId,
  TaskOutcome,
  TaskProgress,
  TaskRecord,
  TaskRegistrationInput,
  TaskRegistrationResult,
  TaskRunState,
} from "./taskCenter";

/** 进度通知的最小间隔（毫秒）。状态转换不受它约束。 */
export const TASK_PROGRESS_THROTTLE_MS = 200;

function isTerminalState(state: TaskRunState): state is TaskFinalState {
  return state !== "running" && state !== "stopping";
}

const nowIso = (): string => new Date(Date.now()).toISOString();

export function createTaskCenterStore(): TaskCenter {
  /** 插入序即注册序：Map 保持插入顺序，快照因此稳定。 */
  const records = new Map<TaskId, TaskRecord>();
  /** 并发键 → 当前持有它的非终态任务。终态转换与 dismiss 时释放。 */
  const activeKeys = new Map<LibraryTransferKey, TaskId>();
  const listeners = new Set<() => void>();

  let lastNotifyAt = -Infinity;
  let pendingTrailing: ReturnType<typeof setTimeout> | null = null;

  function notifyListeners(): void {
    lastNotifyAt = Date.now();
    if (pendingTrailing !== null) {
      clearTimeout(pendingTrailing);
      pendingTrailing = null;
    }
    // 直接迭代 Set：回调中退订（含退订自己）立即生效且不打断迭代，
    // 尚未到达的已退订监听器不再收到本次通知。
    for (const listener of listeners) listener();
  }

  /** 进度专用：窗口内只保留一个尾随通知，数据本身已同步落盘。 */
  function scheduleThrottledNotify(): void {
    const elapsed = Date.now() - lastNotifyAt;
    if (elapsed >= TASK_PROGRESS_THROTTLE_MS) {
      notifyListeners();
      return;
    }
    if (pendingTrailing !== null) return;
    pendingTrailing = setTimeout(() => {
      pendingTrailing = null;
      notifyListeners();
    }, TASK_PROGRESS_THROTTLE_MS - elapsed);
  }

  function existingTask(taskId: TaskId): TaskRecord {
    const record = records.get(taskId);
    if (record === undefined) throw new Error(`任务中心不存在标识为 ${taskId} 的任务`);
    return record;
  }

  function releaseConcurrencyKey(record: TaskRecord): void {
    if (record.concurrencyKey !== null && activeKeys.get(record.concurrencyKey) === record.id) {
      activeKeys.delete(record.concurrencyKey);
    }
  }

  const store: TaskCenter = {
    register(input: TaskRegistrationInput): TaskRegistrationResult {
      if (input.concurrencyKey !== null) {
        const holder = activeKeys.get(input.concurrencyKey);
        if (holder !== undefined) {
          return { kind: "rejected_by_concurrency", conflictingTaskId: holder };
        }
      }
      const record: TaskRecord = {
        id: crypto.randomUUID(),
        kind: input.kind,
        title: input.title,
        libraryId: input.libraryId,
        stoppable: input.stoppable,
        concurrencyKey: input.concurrencyKey,
        state: "running",
        startedAt: nowIso(),
        finishedAt: null,
        progress: null,
        outcome: null,
      };
      records.set(record.id, record);
      if (record.concurrencyKey !== null) activeKeys.set(record.concurrencyKey, record.id);
      notifyListeners();
      return { kind: "registered", record };
    },

    reportProgress(taskId: TaskId, progress: TaskProgress): void {
      const record = existingTask(taskId);
      if (isTerminalState(record.state)) {
        throw new Error(`任务 ${taskId} 已处于终态 ${record.state}，不能再接收进度`);
      }
      records.set(taskId, { ...record, progress });
      scheduleThrottledNotify();
    },

    markStopRequested(taskId: TaskId): void {
      const record = existingTask(taskId);
      if (!record.stoppable) {
        throw new Error(`任务 ${taskId} 不可停止（stoppable=false），不得冒充可取消任务`);
      }
      if (record.state !== "running") {
        throw new Error(`只有 running 任务能请求停止；任务 ${taskId} 当前是 ${record.state}`);
      }
      records.set(taskId, { ...record, state: "stopping" });
      notifyListeners();
    },

    confirmStopped(taskId: TaskId, outcome: TaskOutcome): void {
      const record = existingTask(taskId);
      if (record.state !== "stopping") {
        throw new Error(
          `stopped 只能在使用者请求停止之后由后端确认写入；任务 ${taskId} 当前是 ${record.state}`,
        );
      }
      releaseConcurrencyKey(record);
      records.set(taskId, { ...record, state: "stopped", outcome, finishedAt: nowIso() });
      notifyListeners();
    },

    complete(taskId: TaskId, outcome: TaskOutcome): void {
      const record = existingTask(taskId);
      if (isTerminalState(record.state)) {
        throw new Error(`任务 ${taskId} 已处于终态 ${record.state}，不能重复完成`);
      }
      releaseConcurrencyKey(record);
      // 停止请求与最后一项完成竞速时以真实结果为准：接受 running 或 stopping。
      records.set(taskId, {
        ...record,
        state: deriveTaskFinalState(outcome),
        outcome,
        finishedAt: nowIso(),
      });
      notifyListeners();
    },

    dismiss(taskId: TaskId): void {
      const record = existingTask(taskId);
      if (!isTerminalState(record.state)) {
        throw new Error(`任务 ${taskId} 尚在 ${record.state}：关闭详情面板不是 dismiss，也不会停止任务`);
      }
      records.delete(taskId);
      notifyListeners();
    },

    snapshot: () => [...records.values()],

    subscribe(listener: () => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return store;
}
