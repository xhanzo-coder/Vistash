import { describe, expect, expectTypeOf, test } from "vitest";

import {
  createLibraryTransferKey,
  deriveTaskFinalState,
  isCleanSuccess,
  type LibraryTransferKey,
  type TaskCenter,
  type TaskFailureItem,
  type TaskFinalState,
  type TaskKind,
  type TaskOutcome,
  type TaskOutcomeCounts,
  type TaskRecord,
  type TaskRunState,
} from "./taskCenter";
import type { AppError } from "../shared/types";

function outcome(
  counts: Partial<TaskOutcomeCounts>,
  failures: TaskFailureItem[] = [],
  error: AppError | null = null,
): TaskOutcome {
  return {
    counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0, ...counts },
    failures,
    error,
  };
}

function record(state: TaskRunState, result: TaskOutcome | null): Pick<TaskRecord, "state" | "outcome"> {
  return { state, outcome: result };
}

describe("createLibraryTransferKey", () => {
  test("并发键由库标识构造，导入与导出共用同一把键", () => {
    expect(createLibraryTransferKey("lib-1")).toBe("library:lib-1:transfer");
    // 同一个库的键相同：重叠导入与导出互斥的依据就是这个字面值。
    expect(createLibraryTransferKey("lib-1")).toBe(createLibraryTransferKey("lib-1"));
    expect(createLibraryTransferKey("lib-2")).not.toBe(createLibraryTransferKey("lib-1"));
  });

  test("构造产物就是模板字面量类型本身", () => {
    expectTypeOf(createLibraryTransferKey("x")).toEqualTypeOf<LibraryTransferKey>();
  });
});

describe("deriveTaskFinalState", () => {
  test("没有失败也没有整体错误即成功", () => {
    expect(deriveTaskFinalState(outcome({ succeeded: 5, skipped: 2 }))).toBe("succeeded");
  });

  test("成功与失败并存即部分成功——部分成功是常态，不是异常", () => {
    const failures: TaskFailureItem[] = [
      { displayName: "逆光.png", error: { code: "import.decode_failed", detail: null } },
    ];
    expect(deriveTaskFinalState(outcome({ succeeded: 8, failed: 1 }, failures))).toBe("partial");
  });

  test("全部逐项失败即失败", () => {
    const failures: TaskFailureItem[] = [
      { displayName: "甲.png", error: { code: "import.decode_failed", detail: null } },
      { displayName: "乙.png", error: { code: "library.io_failed", detail: null } },
    ];
    expect(deriveTaskFinalState(outcome({ failed: 2 }, failures))).toBe("failed");
  });

  test("任务级整体错误压过一切逐项计数（迁移整体回滚）", () => {
    expect(
      deriveTaskFinalState(outcome({ succeeded: 3 }, [], { code: "migration.commit_failed", detail: "磁盘写入失败" })),
    ).toBe("failed");
  });

  test("推导结果落在终态子集内", () => {
    expectTypeOf(deriveTaskFinalState(outcome({}))).toEqualTypeOf<
      "succeeded" | "partial" | "failed"
    >();
  });
});

describe("isCleanSuccess（完成报告保留规则）", () => {
  test("干净成功可在查看后移除", () => {
    expect(isCleanSuccess(record("succeeded", outcome({ succeeded: 4 })))).toBe(true);
  });

  test("重复或冲突跳过只是信息量差异，不阻止移除", () => {
    expect(isCleanSuccess(record("succeeded", outcome({ succeeded: 2, skipped: 3 })))).toBe(true);
  });

  test("携带任何失败明细、整体错误或未处理项都必须保留", () => {
    const failure: TaskFailureItem = {
      displayName: "逆光.png",
      error: { code: "export.write_failed", detail: null },
    };
    expect(isCleanSuccess(record("succeeded", outcome({ succeeded: 1, failed: 1 }, [failure])))).toBe(false);
    expect(
      isCleanSuccess(record("succeeded", outcome({}, [], { code: "migration.rollback_done", detail: null }))),
    ).toBe(false);
    expect(isCleanSuccess(record("succeeded", outcome({ unprocessed: 2 })))).toBe(false);
  });

  test("非 succeeded 终态与非终态一律保留到使用者明确关闭", () => {
    for (const state of ["stopping", "stopped", "partial", "failed", "running"] as const) {
      expect(isCleanSuccess(record(state, outcome({ succeeded: 9 })))).toBe(false);
    }
    expect(isCleanSuccess(record("succeeded", null))).toBe(false);
  });
});

describe("类型锁（设计第十三条：六状态与封闭种类）", () => {
  test("运行状态恰好六种：只有后端确认后才进入 stopped", () => {
    expectTypeOf<TaskRunState>().toEqualTypeOf<
      "running" | "stopping" | "stopped" | "succeeded" | "partial" | "failed"
    >();
  });

  test("任务种类恰好五种封闭字面量——不允许任意字符串任务主题", () => {
    expectTypeOf<TaskKind>().toEqualTypeOf<
      "import" | "export" | "migration" | "folder_mutation" | "batch_organization"
    >();
  });

  test("终态是运行状态的四值子集", () => {
    expectTypeOf<TaskFinalState>().toEqualTypeOf<
      Extract<TaskRunState, "stopped" | "succeeded" | "partial" | "failed">
    >();
    expectTypeOf<TaskFinalState>().toExtend<TaskRunState>();
  });
});

describe("TaskCenter interface 可实现性（store 实现在任务 6.3）", () => {
  test("一个不依赖任何框架的最小实现即可满足整个 interface", () => {
    const records: TaskRecord[] = [];
    let nextId = 0;
    const listeners = new Set<() => void>();

    const taskCenter: TaskCenter = {
      register(input) {
        nextId += 1;
        const rec: TaskRecord = {
          id: `task-${nextId}`,
          kind: input.kind,
          title: input.title,
          libraryId: input.libraryId,
          stoppable: input.stoppable,
          concurrencyKey: input.concurrencyKey,
          state: "running",
          startedAt: "2026-08-26T00:00:00Z",
          finishedAt: null,
          progress: null,
          outcome: null,
        };
        records.push(rec);
        return { kind: "registered", record: rec };
      },
      reportProgress() {},
      markStopRequested() {},
      confirmStopped() {},
      complete() {},
      dismiss() {},
      snapshot: () => [...records],
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };

    const registered = taskCenter.register({
      kind: "import",
      title: "导入素材",
      libraryId: "lib-1",
      stoppable: true,
      concurrencyKey: createLibraryTransferKey("lib-1"),
    });
    if (registered.kind !== "registered") {
      throw new TypeError("空任务中心上的首次注册不应被并发键拒绝");
    }
    expect(registered.record.state).toBe("running");
    expect(taskCenter.snapshot()).toHaveLength(1);
  });
});
