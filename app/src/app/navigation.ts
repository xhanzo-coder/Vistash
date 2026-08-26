/**
 * 一级工作区导航的应用级 seam（任务 6.1，设计第三条）。
 *
 * `WorkspaceNavigation` 是应用层拥有的窄 interface：它只回答两件事——当前哪个
 * 一级工作区在前台、某个工作区下一次呈现时要恢复现场还是定位到某个素材。
 * 它必须使用判别联合或明确方法；本文件没有按字符串主题广播的通道，订阅者只
 * 收到"状态变了"这一个信号，内容靠 `entryFor` 拉取，因此不可能演化成无类型的
 * 全局 Event Bus。
 *
 * 提示词工作区跳转一张关联图、全局搜索选中一条结果，都通过 `requestLocate`
 * 进入本 seam；图片模块只会看到自己的定位条目，不知道也不关心请求来自哪里——
 * 这是"两个 UI 模块不得互相导入内部组件、query key 或 store"的结构保证。
 */

import { type RequestId, type Unsubscribe } from "./common";

/** 一级工作区身份。封闭联合：新增一级入口必须显式扩展此处并补全所有匹配臂。 */
export type WorkspaceId = "assets" | "prompts";

/** 定位图片时的目标范围：活动集合或回收站。 */
export type AssetLocationScope = "active" | "trash";

/**
 * 交给某个一级工作区的导航条目。
 *
 * - `resume`：普通切换或首次呈现，模块自行恢复上次的查询与滚动现场。
 * - `locate_asset`：定位一张图片，可落在活动集合或回收站。
 * - `locate_prompt`：定位一条提示词。
 */
export type NavigationEntry =
  | { kind: "resume" }
  | {
      kind: "locate_asset";
      requestId: RequestId;
      hash: string;
      location: AssetLocationScope;
    }
  | {
      kind: "locate_prompt";
      requestId: RequestId;
      promptId: string;
    };

/** 除 resume 外的定位条目：`requestLocate` 只接受这两种。 */
export type LocateEntry = Extract<NavigationEntry, { kind: "locate_asset" | "locate_prompt" }>;

/**
 * 对 [`NavigationEntry`] 的穷尽访问器。
 *
 * 用编译期穷尽性代替运行期兜底：新增条目种类时，遗漏 handler 的调用点直接
 * 无法通过类型检查，而不是落进一个吞掉差异的 default 分支——那正是规格
 * 禁止的业务 fallback。
 */
export function visitNavigationEntry<T>(
  entry: NavigationEntry,
  handlers: {
    resume: () => T;
    locateAsset: (entry: Extract<NavigationEntry, { kind: "locate_asset" }>) => T;
    locatePrompt: (entry: Extract<NavigationEntry, { kind: "locate_prompt" }>) => T;
  },
): T {
  switch (entry.kind) {
    case "resume":
      return handlers.resume();
    case "locate_asset":
      return handlers.locateAsset(entry);
    case "locate_prompt":
      return handlers.locatePrompt(entry);
  }
  // 类型系统已保证上面三分支穷尽；运行期到达这里只能说明判别键被绕过类型
  // 非法构造——这是不变量破坏，按规格抛错而不是静默兜底。
  throw new Error(`未知的导航条目种类：${JSON.stringify(entry)}`);
}

/**
 * 应用层实现的导航控制 interface。
 *
 * 明确方法而不是事件订阅：调用方表达意图（切换、定位），实现方维护当前
 * 工作区与各工作区的待投递条目。`subscribe` 只有一个无参变化信号。
 */
export interface WorkspaceNavigation {
  /** 当前前台的一级工作区。 */
  readonly active: WorkspaceId;
  /**
   * 读取指定工作区下一次呈现时应使用的条目。同一条目可能被多次读到，
   * 模块用 requestId 去重——渲染必须幂等，所以不存在"取走即清"的消费 API。
   */
  entryFor(workspace: WorkspaceId): NavigationEntry;
  /**
   * 切换一级工作区并返回目标工作区将读到的条目。切换不清除已登记的
   * 定位条目：请求是否仍然有效由目标模块按 requestId 判断。
   */
  activate(workspace: WorkspaceId): NavigationEntry;
  /**
   * 登记一条定位条目并把目标工作区带到前台。目标就是当前工作区时只更新
   * 条目——模块重新渲染时按 requestId 消费新请求。
   */
  requestLocate(entry: LocateEntry): void;
  /** 订阅导航变化（切换或新定位）。返回取消订阅函数。 */
  subscribe(listener: () => void): Unsubscribe;
}

/**
 * [`WorkspaceNavigation`] 的应用内参考实现。
 *
 * 刻意不依赖 React 或任何 store：应用外壳把它放进 ref，用 `subscribe` 触发
 * 自己的重渲染；测试直接断言状态语义。默认落在图片工作区——本应用是
 * 图片优先的媒体工作室。
 */
export function createWorkspaceNavigation(initial: WorkspaceId = "assets"): WorkspaceNavigation {
  let active = initial;
  const pendingEntries: Record<WorkspaceId, NavigationEntry> = {
    assets: { kind: "resume" },
    prompts: { kind: "resume" },
  };
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    get active() {
      return active;
    },
    entryFor(workspace) {
      return pendingEntries[workspace];
    },
    activate(workspace) {
      if (workspace !== active) {
        active = workspace;
        notify();
      }
      // 点击已在前台的一级入口不是导航事件：不改条目、不发通知。
      return pendingEntries[workspace];
    },
    requestLocate(entry) {
      active = entry.kind === "locate_asset" ? "assets" : "prompts";
      pendingEntries[active] = entry;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
