import { useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import { loadThumbnail, releaseImageUrl } from "../../shared/ipc";
import type { AppError, AssetRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";

/**
 * 一张缩略图（自 AssetGrid 抽出，瀑布流与详情列表共用）。
 *
 * **只消费后端产出的缩略图。**规格禁止界面层用 `Canvas`、`OffscreenCanvas` 或 `ImageData`
 * 读取像素做缩放、采样或聚类，因此这里除了把字节交给 `<img>` 之外什么都不做。
 *
 * 缩略图缺失时由后端按需重新生成；生成失败必须显式呈现原因，不得留一个空白格位——空白
 * 与"素材本身是空白图像"无法区分。
 */
export function Thumbnail({ asset }: { asset: AssetRow }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
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
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return undefined;
    let current: string | null = null;
    let cancelled = false;

    const load = async () => {
      try {
        const next = await loadThumbnail(asset.hash);
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
  }, [asset.hash, shouldLoad]);

  return (
    <div
      ref={containerRef}
      className="thumbnail-frame"
      aria-busy={shouldLoad && url === null && error === null}
      style={{ aspectRatio: `${asset.width} / ${asset.height}` }}
    >
      {error !== null ? (
        <ErrorLine error={error} />
      ) : url !== null ? (
        <img
          src={url}
          alt={asset.original_filename}
          width={asset.width}
          height={asset.height}
          loading="lazy"
        />
      ) : shouldLoad ? (
        <p>正在载入缩略图…</p>
      ) : (
        <p>等待载入缩略图…</p>
      )}
    </div>
  );
}
