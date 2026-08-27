import { useRef } from "react";

import type { AssetRow } from "../../shared/types";
import { useLazyThumbnailUrl } from "../workspace/thumbnailUrl";
import { ErrorLine } from "../library/ErrorLine";

/**
 * 一张缩略图（自 AssetGrid 抽出，瀑布流与详情列表共用）。
 *
 * **只消费后端产出的缩略图。**规格禁止界面层用 `Canvas`、`OffscreenCanvas` 或 `ImageData`
 * 读取像素做缩放、采样或聚类，因此这里除了把字节交给 `<img>` 之外什么都不做。
 *
 * 缩略图缺失时由后端按需重新生成；生成失败必须显式呈现原因，不得留一个空白格位——空白
 * 与"素材本身是空白图像"无法区分。取数与释放的共享生命周期在 `useLazyThumbnailUrl`。
 */
export function Thumbnail({ asset }: { asset: AssetRow }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { started, url, error } = useLazyThumbnailUrl(containerRef, asset.hash);

  return (
    <div
      ref={containerRef}
      className="thumbnail-frame"
      aria-busy={started && url === null && error === null}
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
      ) : started ? (
        <p>正在载入缩略图…</p>
      ) : (
        <p>等待载入缩略图…</p>
      )}
    </div>
  );
}
