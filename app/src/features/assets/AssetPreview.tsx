import { useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import { loadOriginal, releaseImageUrl } from "../../shared/ipc";
import type { AppError, AssetRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";

/** 角色枚举到中文的映射。取值固定为四种，因此这里可以穷举。 */
export const ROLE_TEXT: Readonly<Record<string, string>> = {
  dominant: "主色",
  secondary: "次要色",
  accent: "强调色",
  neutral: "中性色",
};

/**
 * 聚焦原图模式（任务 9.3）：双击或 Enter 显式进入，占满中央区。
 */
export function AssetPreview({
  asset,
  onClose,
}: {
  asset: AssetRow;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** 剪贴板被拒绝时的提示。它没有后端错误码，因此不走 ErrorLine。 */
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

  // 切换素材时不在这里重置 url 与 error：那是在 effect 里同步 setState，会多触发一轮渲染。
  // 调用方以 asset.hash 作 key 渲染本组件，换素材即重新挂载，状态自然是干净的。
  useEffect(() => {
    let current: string | null = null;
    let cancelled = false;

    const load = async () => {
      try {
        const next = await loadOriginal(asset.hash);
        if (cancelled) {
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

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function copyHex(hex: string) {
    setCopyProblem(null);
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(hex);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // 不假装复制成功。把色号原样显示出来，使用者至少能手动选中。
      setCopied(null);
      setCopyProblem(`无法写入剪贴板。色号是 ${hex}，请手动复制。`);
    }
  }

  return (
    <section className="asset-preview">
      <button type="button" className="back-button" onClick={onClose}>
        退出聚焦
      </button>

      <h2>{asset.original_filename}</h2>
      <p>
        {asset.media_type.toUpperCase()} · {asset.width} × {asset.height} ·{" "}
        {Math.round(asset.byte_size / 1024)} KB
      </p>

      {error !== null && <ErrorLine error={error} />}
      {url === null && error === null && <p>正在载入原图…</p>}
      {url !== null && (
        <img
          className="preview-image"
          src={url}
          alt={asset.original_filename}
          width={asset.width}
          height={asset.height}
        />
      )}

      <h3>色卡</h3>
      {asset.color_card_status === "ok" ? (
        <>
          <ul className="color-card">
            {/*
              key 带上序号而不是只用 hex。同一张色卡里 hex 不会重复（相同 RGB 的像素必然
              归入同一个簇，因此不可能成为两个簇的代表色），但那是个需要推一遍才能确信的
              不变量——React 的 key 不该依赖这种推理。
            */}
            {asset.colors.map((color, ordinal) => (
              <li key={`${ordinal}-${color.hex}`}>
                <button type="button" onClick={() => void copyHex(color.hex)}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: "2rem",
                      height: "2rem",
                      backgroundColor: color.hex,
                    }}
                  />
                  <code>{color.hex}</code>
                  <span>{ROLE_TEXT[color.role] ?? color.role}</span>
                  <span>{Math.round(color.share * 1000) / 10}%</span>
                </button>
                {copied === color.hex && <span role="status">已复制</span>}
              </li>
            ))}
          </ul>
          {copyProblem !== null && <p role="alert">{copyProblem}</p>}
        </>
      ) : (
        <ErrorLine
          error={{
            code: asset.color_card_failure_reason ?? "color_card.cluster_failed",
            detail: `参与聚类的像素数：${asset.color_card_sampled_pixel_count}`,
          }}
        />
      )}
    </section>
  );
}
