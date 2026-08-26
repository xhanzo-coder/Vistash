import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createLibraryTransferKey, type TaskOutcome, type TaskProgress } from "./taskCenter";
import { createTaskCenterStore } from "./taskCenterStore";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  // 假时钟显式接管 Date 与 setTimeout：节流窗口的判定与触发因此完全确定。
  vi.useFakeTimers({ now: new Date("2026-08-26T10:00:00Z"), toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

function importInput(libraryId = "lib-1") {
  return {
    kind: "import" as const,
    title: "导入素材",
    libraryId,
    stoppable: true,
    concurrencyKey: createLibraryTransferKey(libraryId),
  };
}

function batchInput() {
  return {
    kind: "batch_organization" as const,
    title: "批量打标签",
    libraryId: "lib-1",
    stoppable: false,
    concurrencyKey: null,
  };
}

function outcome(counts: Partial<TaskOutcome["counts"]>, error: TaskOutcome["error"] = null): TaskOutcome {
  return {
    counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0, ...counts },
    failures: [],
    error,
  };
}

function transferProgress(done: number, total: number): TaskProgress {
  return { kind: "transfer", done, total, currentFilename: null };
}

describe("注册与任务标识", () => {
  test("注册分配 UUID 标识并落为运行中的初始记录", () => {
    const store = createTaskCenterStore();
    const registered = store.register(importInput());

    if (registered.kind !== "registered") throw new TypeError("空任务中心的首次注册不应被拒绝");
    expect(registered.record.id).toMatch(UUID_PATTERN);
    expect(registered.record.state).toBe("running");
    expect(registered.record.startedAt).toBe("2026-08-26T10:00:00.000Z");
    expect(registered.record.finishedAt).toBeNull();
    expect(registered.record.progress).toBeNull();
    expect(registered.record.outcome).toBeNull();
    expect(store.snapshot()).toHaveLength(1);
  });

  test("快照按注册顺序排列且是副本——外部改动不穿透 store", () => {
    const store = createTaskCenterStore();
    const first = store.register(importInput());
    const second = store.register(batchInput());
    if (first.kind !== "registered" || second.kind !== "registered") {
      throw new TypeError("两个不同并发形态的任务都应注册成功");
    }

    const snapshot = store.snapshot();
    expect(snapshot.map((record) => record.id)).toEqual([first.record.id, second.record.id]);
    // 快照是不可变视图：第二条完成并被移除后，先前取出的快照不受影响。
    store.complete(second.record.id, outcome({ succeeded: 1 }));
    store.dismiss(second.record.id);
    expect(snapshot).toHaveLength(2);
    expect(store.snapshot()).toHaveLength(1);
  });
});

describe("库级并发键", () => {
  test("同一传输键的重叠导入被拒绝并指向正在运行的导入", () => {
    const store = createTaskCenterStore();
    const first = store.register(importInput());
    if (first.kind !== "registered") throw new TypeError("首次注册不应被拒绝");

    const second = store.register(importInput());
    expect(second).toEqual({
      kind: "rejected_by_concurrency",
      conflictingTaskId: first.record.id,
    });
  });

  test("首个任务到达终态后并发键释放，新导入可以启动", () => {
    const store = createTaskCenterStore();
    const first = store.register(importInput());
    if (first.kind !== "registered") throw new TypeError("首次注册不应被拒绝");
    store.complete(first.record.id, outcome({ succeeded: 3 }));

    const second = store.register(importInput());
    expect(second.kind).toBe("registered");
  });

  test("停止确认同样释放并发键；未终态前不放行", () => {
    const store = createTaskCenterStore();
    const first = store.register(importInput());
    if (first.kind !== "registered") throw new TypeError("首次注册不应被拒绝");
    store.markStopRequested(first.record.id);
    // 正在停止还不是终态：重叠任务仍被拒绝。
    expect(store.register(importInput()).kind).toBe("rejected_by_concurrency");

    store.confirmStopped(first.record.id, outcome({ succeeded: 1, unprocessed: 4 }));
    expect(store.register(importInput()).kind).toBe("registered");
  });

  test("无并发键的批量任务互不冲突，跨库的键也不冲突", () => {
    const store = createTaskCenterStore();
    expect(store.register(batchInput()).kind).toBe("registered");
    expect(store.register(batchInput()).kind).toBe("registered");
    expect(store.register(importInput("lib-2")).kind).toBe("registered");
  });
});

describe("状态机与真实停止确认", () => {
  test("markStopRequested 把可停止任务置为正在停止并通知订阅者", () => {
    const store = createTaskCenterStore();
    const registered = store.register(importInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");
    const listener = vi.fn<() => void>();
    store.subscribe(listener);

    store.markStopRequested(registered.record.id);

    const record = store.snapshot()[0];
    if (record === undefined) throw new TypeError("快照不应为空");
    expect(record.state).toBe("stopping");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("不可停止的任务拒绝停止请求——批量组织不得冒充可取消", () => {
    const store = createTaskCenterStore();
    const registered = store.register(batchInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");

    expect(() => store.markStopRequested(registered.record.id)).toThrow(/stoppable|不可停止|无法停止/);
    const record = store.snapshot()[0];
    if (record === undefined) throw new TypeError("快照不应为空");
    expect(record.state).toBe("running");
  });

  test("只有后端确认才进入 stopped，且这是唯一入口", () => {
    const store = createTaskCenterStore();
    const registered = store.register(importInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");
    const id = registered.record.id;

    // 从 running 直接确认停止是不变量破坏：必须先有使用者的停止请求。
    expect(() => store.confirmStopped(id, outcome({}))).toThrow();

    store.markStopRequested(id);
    store.confirmStopped(id, outcome({ succeeded: 2, unprocessed: 5 }));

    const record = store.snapshot()[0];
    if (record === undefined) throw new TypeError("快照不应为空");
    expect(record.state).toBe("stopped");
    expect(record.outcome).toEqual(outcome({ succeeded: 2, unprocessed: 5 }));
    expect(record.finishedAt).not.toBeNull();
  });

  test("complete 从报告推导成功、部分成功或失败", () => {
    const store = createTaskCenterStore();
    const a = store.register(importInput());
    const b = store.register(batchInput());
    const c = store.register({ ...batchInput(), title: "第二条批量" });
    if (a.kind !== "registered" || b.kind !== "registered" || c.kind !== "registered") {
      throw new TypeError("三个任务都应注册成功");
    }

    store.complete(a.record.id, outcome({ succeeded: 4 }));
    store.complete(b.record.id, outcome({ succeeded: 2, failed: 1 }));
    store.complete(c.record.id, outcome({ failed: 3 }, { code: "library.io_failed", detail: null }));

    const states = store.snapshot().map((record) => record.state);
    expect(states).toEqual(["succeeded", "partial", "failed"]);
    for (const record of store.snapshot()) expect(record.finishedAt).not.toBeNull();
  });

  test("停止请求与最后一项完成竞速时以真实结果为准", () => {
    const store = createTaskCenterStore();
    const registered = store.register(importInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");
    store.markStopRequested(registered.record.id);

    store.complete(registered.record.id, outcome({ succeeded: 6 }));

    const record = store.snapshot()[0];
    if (record === undefined) throw new TypeError("快照不应为空");
    expect(record.state).toBe("succeeded");
  });

  test("终态之后再推进状态、重复完成或未知标识都是不变量破坏", () => {
    const store = createTaskCenterStore();
    const registered = store.register(importInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");
    const id = registered.record.id;
    store.complete(id, outcome({ succeeded: 1 }));

    expect(() => store.complete(id, outcome({}))).toThrow();
    expect(() => store.markStopRequested(id)).toThrow();
    expect(() => store.confirmStopped(id, outcome({}))).toThrow();
    expect(() => store.reportProgress(id, transferProgress(1, 1))).toThrow();
    expect(() => store.dismiss("404")).toThrow();
  });
});

describe("进度与节流", () => {
  test("进度数据即时最新：节流只合并通知，不延迟事实", () => {
    const store = createTaskCenterStore();
    const registered = store.register(importInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");

    store.reportProgress(registered.record.id, transferProgress(1, 10));
    store.reportProgress(registered.record.id, transferProgress(2, 10));
    store.reportProgress(registered.record.id, transferProgress(3, 10));

    const record = store.snapshot()[0];
    if (record === undefined) throw new TypeError("快照不应为空");
    expect(record.progress).toEqual(transferProgress(3, 10));
  });

  test("同一节流窗口内的多次进度只合并成一次尾随通知", () => {
    const store = createTaskCenterStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const registered = store.register(importInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");
    // 注册本身立即通知一次。
    expect(notifications).toBe(1);

    vi.advanceTimersByTime(1_000);
    store.reportProgress(registered.record.id, transferProgress(1, 10));
    expect(notifications).toBe(2);

    store.reportProgress(registered.record.id, transferProgress(2, 10));
    store.reportProgress(registered.record.id, transferProgress(3, 10));
    expect(notifications).toBe(2);

    vi.advanceTimersByTime(500);
    expect(notifications).toBe(3);
  });

  test("终态转换立即通知，不受节流窗口压制", () => {
    const store = createTaskCenterStore();
    const registered = store.register(importInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.reportProgress(registered.record.id, transferProgress(1, 1));
    const baseline = notifications;
    store.complete(registered.record.id, outcome({ succeeded: 1 }));

    expect(notifications).toBe(baseline + 1);
  });
});

describe("完成报告保留规则", () => {
  test("dismiss 只接受终态记录：关闭运行中任务的详情绝不是移除记录", () => {
    const store = createTaskCenterStore();
    const running = store.register(importInput());
    if (running.kind !== "registered") throw new TypeError("注册不应被拒绝");
    expect(() => store.dismiss(running.record.id)).toThrow();

    store.markStopRequested(running.record.id);
    expect(() => store.dismiss(running.record.id)).toThrow();

    store.confirmStopped(running.record.id, outcome({ succeeded: 1, unprocessed: 2 }));
    expect(() => store.dismiss(running.record.id)).not.toThrow();
    expect(store.snapshot()).toHaveLength(0);
  });

  test("四种终态记录都可由使用者明确关闭", () => {
    const store = createTaskCenterStore();
    const succeededEntry = store.register(importInput());
    const partialEntry = store.register(batchInput());
    const failedEntry = store.register(batchInput());
    if (
      succeededEntry.kind !== "registered" ||
      partialEntry.kind !== "registered" ||
      failedEntry.kind !== "registered"
    ) {
      throw new TypeError("三条注册都不应被拒绝");
    }
    // 第一条完成后传输键释放，同一条库才能再注册可停止的导入任务。
    store.complete(succeededEntry.record.id, outcome({ succeeded: 1 }));
    const stoppedId = (() => {
      const entry = store.register(importInput());
      if (entry.kind !== "registered") throw new TypeError("键释放后注册不应被拒绝");
      return entry.record.id;
    })();

    store.complete(partialEntry.record.id, outcome({ succeeded: 1, failed: 1 }));
    store.complete(failedEntry.record.id, outcome({}, { code: "migration.rollback_done", detail: null }));
    store.markStopRequested(stoppedId);
    store.confirmStopped(stoppedId, outcome({}));

    expect(store.snapshot()).toHaveLength(4);
    store.dismiss(succeededEntry.record.id);
    store.dismiss(partialEntry.record.id);
    store.dismiss(failedEntry.record.id);
    store.dismiss(stoppedId);
    expect(store.snapshot()).toHaveLength(0);
  });

  test("store 不自动移除任何记录：含失败的报告保留到明确关闭", () => {
    const store = createTaskCenterStore();
    const registered = store.register(batchInput());
    if (registered.kind !== "registered") throw new TypeError("注册不应被拒绝");
    store.complete(registered.record.id, outcome({ failed: 2 }));

    vi.advanceTimersByTime(10_000);
    expect(store.snapshot()).toHaveLength(1);

    store.dismiss(registered.record.id);
    expect(store.snapshot()).toHaveLength(0);
  });
});

describe("订阅信号", () => {
  test("取消订阅后不再收到任何信号", () => {
    const store = createTaskCenterStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    unsubscribe();
    store.register(batchInput());
    expect(notifications).toBe(0);
  });

  test("监听器在回调中退订不会打断同批通知", () => {
    const store = createTaskCenterStore();
    const seen: number[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      seen.push(1);
      unsubscribeFirst();
    });
    store.subscribe(() => {
      seen.push(2);
    });

    store.register(batchInput());
    expect(seen).toEqual([1, 2]);
  });
});
