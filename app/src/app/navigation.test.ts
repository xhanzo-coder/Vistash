import { describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  createWorkspaceNavigation,
  visitNavigationEntry,
  type LocateEntry,
  type NavigationEntry,
  type WorkspaceId,
  type WorkspaceNavigation,
} from "./navigation";
import { parseAssetId } from "./common";

const HASH_A = parseAssetId("a".repeat(64));
const PROMPT_ID = "018f3c9e-6c00-7000-8000-000000000001";

function locateAsset(requestId: string): LocateEntry {
  return { kind: "locate_asset", requestId, hash: HASH_A, location: "trash" };
}

describe("createWorkspaceNavigation", () => {
  test("初始状态是图片工作区加恢复现场条目", () => {
    const nav = createWorkspaceNavigation();
    expect(nav.active).toBe("assets");
    expect(nav.entryFor("assets")).toEqual({ kind: "resume" });
    expect(nav.entryFor("prompts")).toEqual({ kind: "resume" });
  });

  test("显式初始工作区生效", () => {
    expect(createWorkspaceNavigation("prompts").active).toBe("prompts");
  });

  test("activate 切换工作区、返回目标条目并通知订阅者恰好一次", () => {
    const nav = createWorkspaceNavigation();
    const listener = vi.fn<() => void>();
    nav.subscribe(listener);

    const entry = nav.activate("prompts");

    expect(nav.active).toBe("prompts");
    // 切换不清除待投递条目，普通切换读到的就是恢复现场。
    expect(entry).toEqual({ kind: "resume" });
    expect(listener).toHaveBeenCalledExactlyOnceWith();
  });

  test("点击已在前台的一级入口不是导航事件：不发通知也不改条目", () => {
    const nav = createWorkspaceNavigation("prompts");
    nav.requestLocate({ kind: "locate_prompt", requestId: "r1", promptId: PROMPT_ID });
    const listener = vi.fn<() => void>();
    nav.subscribe(listener);

    const entry = nav.activate("prompts");

    expect(entry).toMatchObject({ kind: "locate_prompt", requestId: "r1" });
    expect(listener).not.toHaveBeenCalled();
  });

  test("requestLocate 把目标工作区带到前台并原样登记同一条目", () => {
    const nav = createWorkspaceNavigation("prompts");
    const listener = vi.fn<() => void>();
    nav.subscribe(listener);

    const entry = locateAsset("req-9");
    nav.requestLocate(entry);

    expect(nav.active).toBe("assets");
    // 身份保持：模块拿到的就是登记的那个对象，requestId 与载荷不被复制改写。
    expect(nav.entryFor("assets")).toBe(entry);
    expect(listener).toHaveBeenCalledExactlyOnceWith();
  });

  test("定位到当前前台工作区时只更新条目，工作区不变", () => {
    const nav = createWorkspaceNavigation();
    const first = locateAsset("req-1");
    nav.requestLocate(first);

    const second = { kind: "locate_asset" as const, requestId: "req-2", hash: HASH_A, location: "active" as const };
    nav.requestLocate(second);

    expect(nav.active).toBe("assets");
    expect(nav.entryFor("assets")).toBe(second);
  });

  test("activate 不清除已登记的定位条目：请求是否仍有效由模块按 requestId 判断", () => {
    const nav = createWorkspaceNavigation();
    nav.requestLocate(locateAsset("req-1"));

    nav.activate("prompts");
    nav.activate("assets");

    expect(nav.entryFor("assets")).toMatchObject({ kind: "locate_asset", requestId: "req-1" });
  });

  test("取消订阅后不再收到导航变化通知", () => {
    const nav = createWorkspaceNavigation();
    const listener = vi.fn<() => void>();
    const unsubscribe = nav.subscribe(listener);

    unsubscribe();
    nav.activate("prompts");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("visitNavigationEntry", () => {
  test("三种条目各自派发到对应 handler 并携带收窄后的载荷", () => {
    const entries: NavigationEntry[] = [
      { kind: "resume" },
      { kind: "locate_asset", requestId: "r1", hash: HASH_A, location: "active" },
      { kind: "locate_prompt", requestId: "r2", promptId: PROMPT_ID },
    ];

    const visited = entries.map((entry) =>
      visitNavigationEntry(entry, {
        resume: () => "resume",
        locateAsset: (e) => `asset:${e.hash}:${e.location}`,
        locatePrompt: (e) => `prompt:${e.promptId}`,
      }),
    );

    expect(visited).toEqual(["resume", `asset:${HASH_A}:active`, `prompt:${PROMPT_ID}`]);
  });
});

describe("类型锁（设计第三条：判别联合与明确方法，禁止字符串事件）", () => {
  test("WorkspaceId 恰好是两个一级入口", () => {
    expectTypeOf<WorkspaceId>().toEqualTypeOf<"assets" | "prompts">();
  });

  test("NavigationEntry 的判别键恰好三种", () => {
    expectTypeOf<NavigationEntry["kind"]>().toEqualTypeOf<
      "resume" | "locate_asset" | "locate_prompt"
    >();
  });

  test("requestLocate 的参数面排除 resume——它不是一次定位请求", () => {
    expectTypeOf<WorkspaceNavigation["requestLocate"]>().parameter(0).toEqualTypeOf<LocateEntry>();
    expectTypeOf<LocateEntry["kind"]>().toEqualTypeOf<"locate_asset" | "locate_prompt">();
  });

  test("subscribe 是无参信号加拉取：监听器不接收任何主题或 payload", () => {
    expectTypeOf<WorkspaceNavigation["subscribe"]>().parameter(0).toEqualTypeOf<() => void>();
  });
});
