import { useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import { loadThumbnail, releaseImageUrl } from "../../shared/ipc";
import type { AppError, AssetRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";

/**
 * 一张缩略图。
 *
 * **只消费后端产出的缩略图。**规格禁止界面层用 `Canvas`、`OffscreenCanvas` 或 `ImageData`
 * 读取像素做缩放、采样或聚类，因此这里除了把字节交给 `<img>` 之外什么都不做。
 *
 * 缩略图缺失时由后端按需重新生成；生成失败必须显式呈现原因，不得留一个空白格位——空白
 * 与"素材本身是空白图像"无法区分。
 */
function Thumbnail({ asset }: { asset: AssetRow }) {
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

/**
 * 缩略图网格。
 *
 * 本次刻意不做视觉取舍：列数、卡片尺寸与间距留给后继变更的 `frontend-design`，
 * 记录在设计的待确定问题三。这里只保证结构与行为正确。
 */
export function AssetGrid({
  assets,
  onSelect,
}: {
  assets: AssetRow[];
  onSelect: (asset: AssetRow) => void;
}) {
  if (assets.length === 0) {
    return (
      <div className="empty-state">
        <p className="eyebrow">NO ASSETS</p>
        <h3>这里还没有匹配的素材</h3>
        <p>调整查询条件，或把图片文件与文件夹拖进窗口导入。</p>
      </div>
    );
  }

  return (
    <ul className="asset-grid">
      {assets.map((asset) => (
        <li key={asset.hash} className="asset-card">
          <button type="button" onClick={() => onSelect(asset)}>
            {/* key 用 hash：缩略图的载入状态必须随素材而重置，而不是跟着列表位置。 */}
            <Thumbnail key={asset.hash} asset={asset} />
            <span className="asset-name">{asset.original_filename}</span>
            <span className="asset-dimensions">
              {asset.width} × {asset.height}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
