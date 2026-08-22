import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import { waterfallMetrics } from "../assets/waterfallMetrics";
import { estimatedPromptCardHeight } from "./promptCardMetrics";
import { PromptCoverImage } from "./PromptCoverImage";
import { promptDisplayTitle } from "./promptDisplay";
import { useRovingFocus } from "../workspace/rovingFocus";
import { useScrollRestore } from "../workspace/scrollRestore";
import { useSelection } from "../workspace/selectionContext";
import type { PromptRow } from "../../shared/types";

/** 列间与行间距（CSS px），与图片瀑布流共用同一节奏。 */
const GAP = 12;

type PromptCardWaterfallProps = {
  /** 当前查询的有序结果：选择模型与窗口化的定义域。 */
  prompts: readonly PromptRow[];
  /** 布局偏好里保存的滚动偏移键，挂载时据此恢复。 */
  scrollKey: string;
  savedOffset: number;
  /** 滚动经此上报；防抖持久化由分库布局偏好模型负责。 */
  onScrollOffset: (offset: number) => void;
  /** 收藏开关上报目标状态；写入与快照刷新由工作区负责。 */
  onToggleFavorite: (id: string, favorite: boolean) => void;
  /** 密度旋钮：期望卡片宽度。 */
  targetTileWidth?: number;
};

/** 显式封面；缺省时回落到第一张关联图（后端约定），仍取不到才退化为纯文本卡片。 */
function coverHashOf(prompt: PromptRow): string | null {
  if (prompt.cover_image_hash !== null && prompt.linked_image_hashes.includes(prompt.cover_image_hash)) {
    return prompt.cover_image_hash;
  }
  return prompt.linked_image_hashes[0] ?? null;
}

/**
 * 虚拟化提示词卡片瀑布流（任务 10.1）。
 *
 * 卡片身份是提示词素材而非关联图片（规格）：有关联图片时最多展示一张封面加
 * `+N` 计数，无图片时就是一张可读的纯文本卡片，不要求占位图。选择权威在统一
 * SelectionModel，位置窗口化交给 @tanstack/react-virtual 的 lanes——与图片
 * 瀑布流完全同构。
 *
 * 卡片主体是一个选择按钮；复制与收藏是叠放在其上的独立按钮。它们不能嵌进选择
 * 按钮里（button 不允许嵌套 button），因此外壳 div 承担定位，操作芯片绝对定位
 * 在角落，键盘顺序为：选择卡片 → 复制 → 收藏。
 */
export function PromptCardWaterfall({
  prompts,
  scrollKey,
  savedOffset,
  onScrollOffset,
  onToggleFavorite,
  targetTileWidth = 280,
}: PromptCardWaterfallProps) {
  const { state, onItemClick, handleKeyDown } = useSelection();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // 容器宽度驱动列数密度；jsdom 无布局时保持 0，组件退化为单列等待真实读数。
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) throw new Error("提示词瀑布流滚动容器在挂载后不存在");
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { columnCount, laneWidth } = waterfallMetrics(containerWidth, targetTileWidth, GAP);

  // 定点豁免：设计第八条把位置与可见项锁定给 @tanstack/react-virtual；它返回的
  // 函数只在本组件内消费，不进 memo 化子组件。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: prompts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const prompt = prompts[index];
      return prompt === undefined
        ? laneWidth
        : estimatedPromptCardHeight(laneWidth, prompt) + GAP;
    },
    overscan: 6,
    lanes: columnCount,
    getItemKey: (index) => prompts[index]?.id ?? String(index),
  });

  useScrollRestore(scrollRef, scrollKey, savedOffset);

  // 键盘导航后把活动项滚进窗口并把焦点交给对应卡片；回调随行数组与虚拟化实例
  // 保持稳定，避免无关渲染反复触发聚焦。
  const findById = useCallback(
    (id: string) => prompts.findIndex((prompt) => prompt.id === id),
    [prompts],
  );
  const scrollToIndex = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: "auto" });
    },
    [virtualizer],
  );
  const findItem = useCallback(
    (id: string) =>
      scrollRef.current?.querySelector<HTMLElement>(
        `[data-prompt-card][data-id="${id}"]`,
      ) ?? null,
    [],
  );
  useRovingFocus(scrollRef, state.focusedId, findById, scrollToIndex, findItem);

  // 剪贴板反馈：成功一闪而过，失败显式说明出路。它没有后端错误码，不走 ErrorLine。
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function copyBody(id: string, body: string) {
    setCopyProblem(null);
    try {
      await navigator.clipboard.writeText(body);
      setCopiedId(id);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setCopiedId(null);
      setCopyProblem("无法写入剪贴板。可在检查器中打开正文手动复制。");
    }
  }

  return (
    <div
      ref={scrollRef}
      className="prompt-waterfall"
      /* 瀑布流是 listbox 键盘模式（任务 11.3）：卡片命中区是选项，方向键/
         Home/End 与 Shift 范围由统一 SelectionModel 接管；卡内的复制/收藏是
         Tab 可达的附属控件，不参与方向键巡游。 */
      role="listbox"
      aria-multiselectable="true"
      aria-orientation="vertical"
      onScroll={(event: UIEvent<HTMLDivElement>) => onScrollOffset(event.currentTarget.scrollTop)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (handleKeyDown(event)) {
          event.preventDefault();
        }
      }}
    >
      <div className="prompt-waterfall-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {copyProblem !== null && (
          <p role="alert" className="prompt-copy-problem">
            {copyProblem}
          </p>
        )}
        {virtualizer.getVirtualItems().map((item) => {
          const prompt = prompts[item.index];
          if (prompt === undefined) return null;
          const selected = state.selectedIds.has(prompt.id);
          const active = state.activeId === prompt.id;
          const title = promptDisplayTitle(prompt);
          const cover = coverHashOf(prompt);
          const linkedCount = prompt.linked_image_hashes.length;
          return (
            <div
              key={item.key}
              className="prompt-card-shell"
              style={{
                width: laneWidth,
                height: item.size - GAP,
                transform: `translate(${item.lane * (laneWidth + GAP)}px, ${item.start}px)`,
              }}
            >
              <button
                type="button"
                role="option"
                data-prompt-card=""
                data-index={item.index}
                data-id={prompt.id}
                aria-selected={selected}
                aria-label={
                  linkedCount > 0 ? `${title}（关联 ${linkedCount} 张图片）` : title
                }
                tabIndex={state.focusedId === prompt.id ? 0 : -1}
                className={`prompt-card-hit${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
                onClick={(event) => {
                  // 显式移交焦点：Safari 点击按钮不产生原生聚焦，键盘巡游依赖它。
                  event.currentTarget.focus();
                  onItemClick(prompt.id, event);
                }}
              >
                {cover !== null && (
                  <span className="prompt-card-cover">
                    <PromptCoverImage coverHash={cover} />
                    {linkedCount > 1 && (
                      <span className="prompt-card-count" aria-hidden="true">
                        +{linkedCount - 1}
                      </span>
                    )}
                  </span>
                )}
                <span className="prompt-card-title">{title}</span>
                <span className={`prompt-card-body${cover === null ? " is-text-only" : ""}`}>
                  {prompt.body}
                </span>
              </button>
              <span className="prompt-card-actions">
                <button
                  type="button"
                  aria-label={`复制正文 ${title}`}
                  onClick={() => void copyBody(prompt.id, prompt.body)}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="prompt-favorite-toggle"
                  aria-pressed={prompt.favorite}
                  aria-label={`${prompt.favorite ? "取消收藏" : "收藏"} ${title}`}
                  onClick={() => onToggleFavorite(prompt.id, !prompt.favorite)}
                >
                  {prompt.favorite ? "★" : "☆"}
                </button>
              </span>
              {copiedId === prompt.id && (
                <span role="status" className="prompt-copy-status">
                  已复制
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
