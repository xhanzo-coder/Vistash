/**
 * 统一 SelectionModel 的状态机合同（任务 8.4，设计第七条）。
 *
 * 图片瀑布流/列表与提示词卡片/列表共用同一台状态机与同一套键盘语法；渲染器各自
 * 优化但都不持有选择权威。这里逐条钉住：单击、Ctrl/Shift 组合、框选、Ctrl+A、
 * 活动项移动、范围锚点、Esc 与跨视图保留。
 */

import { describe, expect, test } from "vitest";

import {
  type SelectionAction,
  type SelectionState,
  initialSelection,
  selectionReducer,
} from "./selection";

const IDS = ["a", "b", "c", "d", "e"] as const;

function started(ids: readonly string[] = IDS): SelectionState {
  return selectionReducer(initialSelection(ids), { kind: "selectOne", id: "b" });
}

/** 除有序 ID 外的全部字段简写比较。 */
function expectState(
  state: SelectionState,
  expected: Omit<SelectionState, "orderedIds">,
): void {
  const { orderedIds: _ids, ...rest } = state;
  expect(rest).toEqual(expected);
}

describe("单击与组合键", () => {
  test("单击把选中、活动、锚点与聚焦都设为该项；再单击另一项替换选中", () => {
    const first = selectionReducer(initialSelection(IDS), { kind: "selectOne", id: "a" });
    expectState(first, {
      activeId: "a",
      selectedIds: new Set(["a"]),
      anchorId: "a",
      focusedId: "a",
    });

    const second = selectionReducer(first, { kind: "selectOne", id: "c" });
    expectState(second, {
      activeId: "c",
      selectedIds: new Set(["c"]),
      anchorId: "c",
      focusedId: "c",
    });
  });

  test("Ctrl+单击切换成员资格、保留其他选中，活动与锚点跟随被点项", () => {
    const base = started();
    const added = selectionReducer(base, { kind: "toggleOne", id: "d" });
    expectState(added, {
      activeId: "d",
      selectedIds: new Set(["b", "d"]),
      anchorId: "d",
      focusedId: "d",
    });

    // 再 Ctrl+单击同一项：移出选中，但活动仍跟随最后一次点击的位置。
    const removed = selectionReducer(added, { kind: "toggleOne", id: "d" });
    expectState(removed, {
      activeId: "d",
      selectedIds: new Set(["b"]),
      anchorId: "d",
      focusedId: "d",
    });
  });

  test("Shift+单击从锚点选范围并替换先前选中，锚点保持不动", () => {
    const base = started(); // 锚点在 b

    const down = selectionReducer(base, { kind: "rangeTo", id: "d" });
    expectState(down, {
      activeId: "d",
      selectedIds: new Set(["b", "c", "d"]),
      anchorId: "b",
      focusedId: "d",
    });

    // 反向越过锚点：范围同样成立。
    const up = selectionReducer(base, { kind: "rangeTo", id: "a" });
    expectState(up, {
      activeId: "a",
      selectedIds: new Set(["a", "b"]),
      anchorId: "b",
      focusedId: "a",
    });
  });

  test("没有锚点时 Shift+单击退化为普通单击", () => {
    const bare = initialSelection(IDS);
    const ranged = selectionReducer(bare, { kind: "rangeTo", id: "c" });
    expectState(ranged, {
      activeId: "c",
      selectedIds: new Set(["c"]),
      anchorId: "c",
      focusedId: "c",
    });
  });
});

describe("框选与全选", () => {
  test("框选默认替换选中；additive 时并入既有选中", () => {
    const base = started();

    const replaced = selectionReducer(base, { kind: "boxSelect", ids: ["c", "d"] });
    expectState(replaced, {
      activeId: "b",
      selectedIds: new Set(["c", "d"]),
      anchorId: "b",
      focusedId: "b",
    });

    const merged = selectionReducer(replaced, {
      kind: "boxSelect",
      ids: ["a"],
      additive: true,
    });
    expectState(merged, {
      activeId: "b",
      selectedIds: new Set(["a", "c", "d"]),
      anchorId: "b",
      focusedId: "b",
    });
  });

  test("Ctrl+A 全部选中，活动与锚点不变", () => {
    const base = started();
    const all = selectionReducer(base, { kind: "selectAll" });
    expectState(all, {
      activeId: "b",
      selectedIds: new Set(IDS),
      anchorId: "b",
      focusedId: "b",
    });
  });

  test("Esc 清空选中但保留活动与聚焦", () => {
    // started() 的锚点在 b，rangeTo 不移动锚点；Esc 也不动它。
    const base = selectionReducer(started(), { kind: "rangeTo", id: "e" });
    const cleared = selectionReducer(base, { kind: "clear" });
    expectState(cleared, {
      activeId: "e",
      selectedIds: new Set(),
      anchorId: "b",
      focusedId: "e",
    });
  });
});

describe("活动项与范围扩展", () => {
  test("方向键移动活动项与聚焦；Shift 同时扩展范围", () => {
    const base = started(); // b，锚点 b

    const next = selectionReducer(base, { kind: "moveActive", step: "next" });
    expectState(next, {
      activeId: "c",
      selectedIds: new Set(["c"]),
      anchorId: "c",
      focusedId: "c",
    });

    // 从 b 出发 Shift+next：范围向尾部生长，锚点不动。
    const grown = selectionReducer(started(), {
      kind: "moveActive",
      step: "next",
      extend: true,
    });
    expectState(grown, {
      activeId: "c",
      selectedIds: new Set(["b", "c"]),
      anchorId: "b",
      focusedId: "c",
    });

    // 再 Shift+prev 收回：范围缩回但不越过锚点清空到少于锚点自身。
    const shrunk = selectionReducer(grown, {
      kind: "moveActive",
      step: "prev",
      extend: true,
    });
    expectState(shrunk, {
      activeId: "b",
      selectedIds: new Set(["b"]),
      anchorId: "b",
      focusedId: "b",
    });
  });

  test("Home/End 直达边界；边界外不再移动", () => {
    const base = started();
    const end = selectionReducer(base, { kind: "moveActive", step: "last" });
    expect(end.activeId).toBe("e");
    const beyond = selectionReducer(end, { kind: "moveActive", step: "next" });
    expect(beyond.activeId).toBe("e");

    const home = selectionReducer(base, { kind: "moveActive", step: "first" });
    expect(home.activeId).toBe("a");
  });

  test("空查询上的任何动作都不产生越界状态", () => {
    let state = initialSelection([]);
    for (const action of [
      { kind: "selectOne", id: "x" },
      { kind: "toggleOne", id: "x" },
      { kind: "rangeTo", id: "x" },
      { kind: "boxSelect", ids: ["x"] },
      { kind: "selectAll" },
      { kind: "clear" },
      { kind: "moveActive", step: "next" },
    ] as SelectionAction[]) {
      state = selectionReducer(state, action);
    }
    expect(state.activeId).toBeNull();
    expect(state.selectedIds.size).toBe(0);
  });
});

describe("跨视图保留", () => {
  test("同一查询域换视图（瀑布流↔列表）后选择原样保留", () => {
    const base = selectionReducer(started(), { kind: "toggleOne", id: "e" });
    // 视图切换重新下发同一批 ID：一切字段必须原样存活。
    const sameDomain = selectionReducer(base, { kind: "idsReplaced", ids: IDS });
    expect(sameDomain).toEqual(base);
  });

  test("查询缩小后只保留交集，越界的活动/锚点/聚焦回退为空", () => {
    const base = selectionReducer(started(), { kind: "rangeTo", id: "e" });
    const filtered = selectionReducer(base, { kind: "idsReplaced", ids: ["a", "c"] });
    expectState(filtered, {
      activeId: null,
      selectedIds: new Set(["c"]),
      anchorId: null,
      focusedId: null,
    });
  });

  test("查询扩大（如删除后还原）不影响既有选中", () => {
    const base = started();
    const grown = selectionReducer(base, { kind: "idsReplaced", ids: [...IDS, "f"] });
    expectState(grown, {
      activeId: "b",
      selectedIds: new Set(["b"]),
      anchorId: "b",
      focusedId: "b",
    });
    expect(grown.orderedIds).toEqual([...IDS, "f"]);
  });
});
