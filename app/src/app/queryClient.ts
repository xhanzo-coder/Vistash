import { QueryClient } from "@tanstack/react-query";

/**
 * 历史筛选查询的最长闲置缓存时间。
 *
 * 集合查询可能一次包含 10,000 条轻量行，因此不能使用无限缓存；五分钟足以支持
 * 使用者在相邻筛选间往返，同时会回收已经离开工作现场的查询。媒体字节不进入
 * Query cache，其生命周期由 `ImageLease.release` 独立管理。
 */
export const APP_QUERY_GC_TIME_MS = 5 * 60 * 1_000;

/** 为一次应用启动创建唯一 QueryClient。测试也通过此工厂取得彼此隔离的实例。 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        gcTime: APP_QUERY_GC_TIME_MS,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
