import { describe, expect, test } from "vitest";

import { APP_QUERY_GC_TIME_MS, createAppQueryClient } from "./queryClient";

describe("应用 QueryClient 策略", () => {
  test("IPC 查询不自动重试，也不因窗口聚焦或网络重连刷新整个库", () => {
    const queries = createAppQueryClient().getDefaultOptions().queries;

    expect(queries?.retry).toBe(false);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.refetchOnReconnect).toBe(false);
  });

  test("查询缓存有明确有限生命周期，mutation 同样不自动重试", () => {
    const defaults = createAppQueryClient().getDefaultOptions();

    expect(defaults.queries?.gcTime).toBe(APP_QUERY_GC_TIME_MS);
    expect(Number.isFinite(defaults.queries?.gcTime)).toBe(true);
    expect(defaults.mutations?.retry).toBe(false);
  });
});
