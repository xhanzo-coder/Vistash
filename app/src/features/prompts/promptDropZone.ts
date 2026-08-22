import type { FileDragEvent } from "../../shared/ipc";

/**
 * 关联图片区的窗口级拖放认领（任务 10.5）。
 *
 * Tauri 的文件拖放事件在 webview 层广播：任何落点都会送达每一个监听者，因此
 * "放进关联图片区"的导入并关联必须与 App 的整库导入互斥，而两者各自持有独立的
 * 事件订阅、触发顺序没有任何保证。这里的解法是把判定收敛成一条只读的共享状态：
 *
 * - 挂载中的关联区登记自己的几何范围与落点处理器；
 * - 拖动事件（enter/move/drop）持续更新最新物理坐标；
 * - App 在自己的 drop 分发前询问"最新落点是否被关联区认领"——查询读的是同一份
 *   坐标快照，与监听者触发顺序无关。
 *
 * 与 `draftGuard` 同一模式：单槽位注册表，组件卸载即注销，无组件登记时一切落点
 * 都回到默认语义（整库导入）。
 */
export type PromptDropZoneRegistration = {
  /** 返回拖放目标的当前几何范围；目标不在文档中时返回 null。逻辑像素。 */
  rect: () => DOMRect | null;
  /** 落点命中时的处理：接收拖入的文件路径列表。 */
  drop: (paths: string[]) => void;
};

let registration: PromptDropZoneRegistration | null = null;
/** 最新一次拖动事件的物理像素坐标；尚未发生拖动时为 null。 */
let latestPhysical: { x: number; y: number } | null = null;
let hovering = false;
const hoverListeners = new Set<(hovering: boolean) => void>();

function logicalPoint(physical: { x: number; y: number }): { x: number; y: number } {
  const ratio = window.devicePixelRatio;
  // 非正的比例不是真实环境：按 1 处理，宁可误判不命中也不除零。
  const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return { x: physical.x / scale, y: physical.y / scale };
}

function pointInRect(point: { x: number; y: number }, rect: DOMRect): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

function setHovering(next: boolean): void {
  if (hovering === next) return;
  hovering = next;
  for (const listener of hoverListeners) listener(hovering);
}

/** 登记或注销当前关联区的拖放认领。单槽位：新登记覆盖旧值。 */
export function setPromptDropZone(next: PromptDropZoneRegistration | null): void {
  registration = next;
  if (next === null) {
    latestPhysical = null;
    setHovering(false);
  }
}

/**
 * App 的默认导入分发前调用：最新落点落在登记中的关联区内吗。
 * 只读共享快照，与各监听者的触发顺序无关。
 */
export function promptDropClaimsLatestPoint(): boolean {
  if (registration === null || latestPhysical === null) return false;
  return claimsPoint(registration, latestPhysical);
}

/** 登记中的关联区是否认领这个物理坐标。 */
function claimsPoint(
  zone: PromptDropZoneRegistration,
  physical: { x: number; y: number },
): boolean {
  const rect = zone.rect();
  return rect !== null && pointInRect(logicalPoint(physical), rect);
}

/** 模块内统一的拖动事件入口：由持有 onFileDragEvent 订阅的组件转交。 */
export function handleFileDragEvent(event: FileDragEvent): void {
  if (event.type === "leave") {
    latestPhysical = null;
    setHovering(false);
    return;
  }
  latestPhysical = { x: event.x, y: event.y };
  // 先取局部常量再判定：模块级变量在函数调用间不保持收窄。
  const zone = registration;
  if (event.type === "drop") {
    setHovering(false);
    if (zone !== null && claimsPoint(zone, latestPhysical)) zone.drop(event.paths);
    return;
  }
  setHovering(zone !== null && claimsPoint(zone, latestPhysical));
}

/** 订阅悬停高亮状态变化；返回取消订阅的函数。 */
export function subscribePromptDropHover(listener: (hovering: boolean) => void): () => void {
  hoverListeners.add(listener);
  listener(hovering);
  return () => {
    hoverListeners.delete(listener);
  };
}
