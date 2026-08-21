/*
 * 全局测试准备（所有测试文件共享）。
 *
 * jsdom 缺三类工作台依赖的浏览器能力，这里补最小桩：
 * - matchMedia：窗口层级钩子（任务 8.6）与挂载完整工作台的组件测试都需要；
 *   需要模拟断点翻转的测试自行用可配置属性覆盖。
 * - ResizeObserver：TanStack 虚拟化与瀑布流容器宽度都靠它驱动。模拟真实观察者
 *   的行为——observe 时以元素当前几何读数回调一次；需要后续触发的测试用
 *   vi.stubGlobal 覆盖。
 * - IntersectionObserver：懒加载缩略图靠它；默认"休眠"（不触发回调），
 *   避免无关测试真的发起缩略图 IPC。
 */

function stubRect(width: number, height: number) {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  };
}

if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  if (typeof window.ResizeObserver !== "function") {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class implements ResizeObserver {
        readonly root: Element | Document | null = null;
        readonly rootMargin = "";
        readonly scrollMargin = "";
        readonly thresholds: ReadonlyArray<number> = [];
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element): void {
          const rect = target.getBoundingClientRect();
          const entry = {
            target,
            contentRect: stubRect(rect.width, rect.height),
            borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          };
          queueMicrotask(() => {
            this.callback([entry], this);
          });
        }
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): ResizeObserverEntry[] {
          return [];
        }
      },
    });
  }

  if (typeof window.IntersectionObserver !== "function") {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        disconnect(): void {}
        observe(): void {}
        unobserve(): void {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      },
    });
  }
}
