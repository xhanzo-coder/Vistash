/*
 * 全局测试准备（所有测试文件共享）。
 *
 * jsdom 没有实现 matchMedia，而工作台的窗口层级钩子（任务 8.6）以及挂载完整
 * 工作台的组件测试都会触到它。这里补一个恒为"不匹配"的桩：需要模拟断点翻转的
 * 测试（breakpoints.test.tsx）自行用可配置属性覆盖。
 */

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
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
