import { useEffect, useState } from "react";

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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
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
  }, [asset.hash]);

  if (error !== null) return <ErrorLine error={error} />;
  if (url === null) return <p>正在载入缩略图…</p>;
  return <img src={url} alt={asset.original_filename} />;
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
    return <p>库里还没有素材。把图片文件或文件夹拖进窗口即可导入。</p>;
  }

  return (
    <ul>
      {assets.map((asset) => (
        <li key={asset.hash}>
          <button type="button" onClick={() => onSelect(asset)}>
            {/* key 用 hash：缩略图的载入状态必须随素材而重置，而不是跟着列表位置。 */}
            <Thumbnail key={asset.hash} asset={asset} />
            <span>{asset.original_filename}</span>
            <span>
              {asset.width} × {asset.height}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
