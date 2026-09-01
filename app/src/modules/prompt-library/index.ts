/**
 * `prompt-library` 模块的唯一公共出口。
 *
 * 本模块承载提示词工作区；现有实现随阶段 11 的切换迁入，在此之前保持现状
 * 行为与一级入口。其他模块与应用外壳只允许从本文件导入，
 * `internal/` 是实现细节——结构检查 `scripts/module-boundaries.lib.mjs`
 * 强制这一契约。这里先行冻结与图片模块对称的组合属性形状。
 */

import { createElement, useMemo, type ReactNode } from "react";
import type { RequestId } from "../../app/common";
import type { OpenLibrarySession } from "../library-lifecycle";
import type { ImagePromptRelations } from "../image-prompt-relations";
import { PromptWorkspace } from "./internal/PromptWorkspace";
export { blockIfPromptDraftDirty } from "../../features/prompts/draftGuard";

/** 提示词工作区的组合属性：由应用外壳持有会话与一级导航状态后下发。 */
export type PromptLibraryWorkspaceProps = {
  session: OpenLibrarySession;
  relations: ImagePromptRelations;
  /** 是否为当前激活的一级工作区；非激活时模块挂起交互但保留现场。 */
  active: boolean;
  /** 待处理的提示词定位条目；模块消费后按 requestId 去重。 */
  entry?: PromptLibraryEntry;
  onEntryHandled?: (requestId: RequestId) => void;
};

export type PromptLibraryEntry =
  | { kind: "resume" }
  | { kind: "locate"; requestId: RequestId; id: string; inTrash: boolean };

type PromptLocateBridge = { section: "prompts"; id: string; inTrash: boolean; nonce: number };

const requestNonceById = new Map<RequestId, number>();
let nextRequestNonce = 0;
function requestNonce(requestId: RequestId): number {
  const known = requestNonceById.get(requestId);
  if (known !== undefined) return known;
  const value = ++nextRequestNonce;
  requestNonceById.set(requestId, value);
  return value;
}

/**
 * 提示词模块的组合出口。
 *
 * 现有提示词工作区已经具备稳定行为与完整回归覆盖；这里把它接到新的应用壳层
 * session/navigation interface，避免 App 直接依赖旧 feature 文件。请求 ID 到旧
 * 工作区数值 nonce 的转换只发生在模块边界内，不向外暴露旧协议。
 */
export function PromptLibraryWorkspace({
  active,
  entry,
  onEntryHandled,
  relations,
  session,
}: PromptLibraryWorkspaceProps): ReactNode {
  const locate = useMemo<(PromptLocateBridge | null)>(() => {
    if (entry === undefined || entry.kind === "resume") return null;
    return {
      section: "prompts",
      id: entry.id,
      inTrash: entry.inTrash,
      nonce: requestNonce(entry.requestId),
    };
  }, [entry]);
  const handled = (value: number): void => {
    if (entry?.kind === "locate" && value === requestNonce(entry.requestId)) onEntryHandled?.(entry.requestId);
  };
  return createElement(PromptWorkspace, {
    key: session.id,
    libraryId: session.id,
    relations,
    locate,
    onLocateHandled: handled,
    // 外层 AppShell 负责可见性；工作区自身按 active 暂停抓取并让集合子视图
    // 释放媒体租约，父级状态因此不会因一级入口切换而丢失。
    active,
  });
}
