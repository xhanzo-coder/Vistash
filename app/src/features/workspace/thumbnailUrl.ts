/**
 * 懒加载缩略图 URL 的共享生命周期（任务 10.1 自 Thumbnail 抽出）。
 *
 * 图片瀑布流、详情列表与提示词卡片封面都要同一套纪律：进入视口附近才开始加载；
 * 卸载或换哈希时立刻释放 `blob:` URL，否则字节会一直钉在内存里。钩子只负责
 * 取数与释放，呈现分支（载入中/失败/就绪的文案与画幅）由调用方决定。
 */

import { useEffect, useState, type RefObject } from "react";

import { asAppError } from "../../shared/errors";
import { loadThumbnail, releaseImageUrl } from "../../shared/ipc";
import type { AppError } from "../../shared/types";

export type LazyThumbnailState = {
  /** 观察器已确认容器进入视口附近，加载流程可以开始。 */
  readonly started: boolean;
  readonly url: string | null;
  readonly error: AppError | null;
};

export function useLazyThumbnailUrl(
  containerRef: RefObject<HTMLElement | null>,
  hash: string,
): LazyThumbnailState {
  const [started, setStarted] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      throw new Error("缩略图容器在挂载后不存在");
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!started) return undefined;
    let current: string | null = null;
    let cancelled = false;

    const load = async () => {
      try {
        const next = await loadThumbnail(hash);
        if (cancelled) {
          // 组件已卸载：立刻释放，否则这份字节会一直钉在内存里。
          releaseImageUrl(next);
          return;
        }
        current = next;
        setUrl(next);
      } catch (raw) {
        if (!cancelled) setError(asAppError(raw));
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (current !== null) releaseImageUrl(current);
    };
  }, [hash, started]);

  return { started, url, error };
}
