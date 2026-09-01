import { useSyncExternalStore } from "react";

import type { WorkspacePaneMode } from "../../../features/workspace/workspacePaneLayout";

export const PROMPT_RAIL_BREAKPOINT = 1050;
export const PROMPT_INSPECTOR_BREAKPOINT = 780;

export type PromptPaneModes = {
  rail: WorkspacePaneMode;
  inspector: WorkspacePaneMode;
};

/** 提示词页的两侧栏按产品规格独立降级，不能复用图片页“两栏同时收起”的层级。 */
export function promptPaneModes(width: number): PromptPaneModes {
  return {
    rail: width <= PROMPT_RAIL_BREAKPOINT ? "drawer" : "inline",
    inspector: width <= PROMPT_INSPECTOR_BREAKPOINT ? "drawer" : "inline",
  };
}

function subscribeViewport(listener: () => void): () => void {
  window.addEventListener("resize", listener, { passive: true });
  return () => window.removeEventListener("resize", listener);
}

function readPaneModes(): string {
  return `${window.innerWidth <= PROMPT_RAIL_BREAKPOINT ? "drawer" : "inline"}:${
    window.innerWidth <= PROMPT_INSPECTOR_BREAKPOINT ? "drawer" : "inline"
  }`;
}

export function usePromptPaneModes(): PromptPaneModes {
  const key = useSyncExternalStore(subscribeViewport, readPaneModes, readPaneModes);
  const [rail, inspector] = key.split(":");
  if ((rail !== "inline" && rail !== "drawer") || (inspector !== "inline" && inspector !== "drawer")) {
    throw new TypeError(`未知提示词栏位模式：${key}`);
  }
  return { rail, inspector };
}
