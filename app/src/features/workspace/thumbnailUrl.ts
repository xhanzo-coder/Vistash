/**
 * 懒加载缩略图 URL 的共享生命周期。
 *
 * 图片瀑布流、详情列表与提示词卡片封面都要同一套纪律：进入视口附近才开始加载；
 * 卸载或换哈希时立刻释放 `blob:` URL，否则字节会一直钉在内存里。钩子只负责
 * 取数与释放，呈现分支（载入中/失败/就绪的文案与画幅）由调用方决定。
 */

import { useEffect, useState, type RefObject } from "react";

import { appPlatform } from "../../app/runtime";
import type { ImageLease } from "../../app/platform";
import { asAppError } from "../../shared/errors";
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
    let current: ImageLease | null = null;
    let cancelled = false;

    const load = async () => {
      try {
        const lease = await appPlatform.acquireThumbnail(hash);
        if (cancelled) {
          // 组件已卸载：立刻释放，否则这份字节会一直钉在内存里。
          lease.release();
          return;
        }
        current = lease;
        setUrl(lease.url);
      } catch (raw) {
        if (!cancelled) setError(asAppError(raw));
      }
    };
    void load();

    return () => {
      cancelled = true;
      current?.release();
    };
  }, [hash, started]);

  return { started, url, error };
}
