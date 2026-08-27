import { useRef } from "react";

import { useLazyThumbnailUrl } from "../workspace/thumbnailUrl";
import { ErrorLine } from "../library/ErrorLine";

/**
 * 提示词卡片的封面缩略图（任务 10.1）。
 *
 * 与素材缩略图共用同一套懒加载生命周期；画幅固定为卡片封面的 3:2，超出部分由
 * `object-fit: cover` 裁剪。图片对卡片而言是装饰：卡片的可访问名称已经携带标题
 * 与关联数量，因此这里的 `alt` 留空，避免读屏器把同一信息读两遍。
 */
export function PromptCoverImage({ coverHash }: { coverHash: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { started, url, error } = useLazyThumbnailUrl(containerRef, coverHash);

  return (
    <div
      ref={containerRef}
      className="prompt-cover-frame"
      aria-busy={started && url === null && error === null}
    >
      {error !== null ? (
        <ErrorLine error={error} />
      ) : url !== null ? (
        <img src={url} alt="" width={3} height={2} loading="lazy" />
      ) : started ? (
        <p>正在载入封面…</p>
      ) : (
        <p>等待载入封面…</p>
      )}
    </div>
  );
}
