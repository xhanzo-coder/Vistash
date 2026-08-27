/**
 * 基线测量的共享 fixture 与 IPC 桩（任务 11.4）。
 *
 * measure-perf 与诊断脚本共同消费：buildBootstrap() 返回一段注入页面的初始化
 * 脚本——先铺 10,000 条素材/提示词数据，再把 window.__TAURI_INTERNALS__ 换成
 * 内存桩，让 release 渲染层在真实浏览器里完整跑起来。
 */

/** 一组画幅循环取值：瀑布流的列高估算依赖画幅多样性。 */
const SHAPES = [
  [1920, 1080],
  [1080, 1350],
  [1350, 1080],
  [1024, 1024],
  [2048, 1152],
  [900, 1600],
];

const PROMPT_BODY =
  "一段用于压测的长提示词正文。".repeat(24) +
  "\n正向：电影感布光，浅景深，8k 细节。\n负向：低对比，过曝。" +
  "\n参数：steps=30 sampler=dpm++ cfg=7 seed 固定。";

export function makeAssets(count) {
  return Array.from({ length: count }, (_, i) => {
    const [width, height] = SHAPES[i % SHAPES.length];
    return {
      hash: String(i).padStart(64, "0"),
      hash_algo: "sha256",
      media_type: "png",
      ext: "png",
      byte_size: 1_200_000 + i,
      width,
      height,
      imported_at: "2026-08-01T00:00:00Z",
      original_filename: `perf-${String(i).padStart(5, "0")}.png`,
      display_filename: `perf-${String(i).padStart(5, "0")}.png`,
      source_path: null,
      deleted_at: null,
      color_card_status: "none",
      color_card_algo_version: 0,
      color_card_failure_reason: null,
      color_card_sampled_pixel_count: 0,
      note: "",
      favorite: i % 7 === 0,
      tags: [`标签${i % 40}`],
      folder: i % 3 === 0 ? "参考" : null,
      colors: [],
    };
  });
}

export function makePrompts(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `prompt-${i}`,
    body: `${PROMPT_BODY}\n第 ${i} 条变体。`,
    title: `压测提示词 ${i}`,
    model: i % 2 === 0 ? "sd-xl" : "flux-1",
    parameters: "steps=30 sampler=dpm++",
    note: "",
    favorite: i % 9 === 0,
    folders: i % 4 === 0 ? ["人像"] : [],
    tags: [`主题${i % 35}`],
    linked_image_hashes: i % 5 === 0 ? [String(i).padStart(64, "0")] : [],
    cover_image_hash: i % 5 === 0 ? String(i).padStart(64, "0") : null,
    resolved_cover_hash: i % 5 === 0 ? String(i).padStart(64, "0") : null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    deleted_at: null,
  }));
}

/** 1×1 PNG：让 <img> 真实解码一个字节源，blob 取数/释放生命周期照常运转。 */
export const THUMB_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** 组装注入页面的初始化脚本：fixture 数据 + Tauri IPC 内存桩。 */
export function buildBootstrap(itemCount) {
  const assets = JSON.stringify(makeAssets(itemCount));
  const prompts = JSON.stringify(makePrompts(itemCount));
  const thumb = JSON.stringify(Array.from(THUMB_PNG));
  return `
    (() => {
      window.__vistashPerf = { assets: ${assets}, prompts: ${prompts}, thumb: ${thumb}, calls: [] };
      let eventId = 0;
      let callbackId = 0;
      const data = window.__vistashPerf;
      const emptySnapshot = () => ({ assets: [], prompts: [], folders: [], tags: [], trash_count: 0 });
      const handlers = {
        library_status: () =>
          ({ path: "E:\\\\perf-fixture", library_id: "perf-fixture", recorded_path: null, problem: null }),
        catalog_snapshot: (args) =>
          args?.query?.location === "trash" ? { ...emptySnapshot(), trash_count: 0 }
            : { assets: data.assets, folders: ["参考"], tags: [], trash_count: 0 },
        prompt_snapshot: (args) =>
          args?.query?.location === "trash" ? { ...emptySnapshot(), trash_count: 0 }
            : { prompts: data.prompts, folders: ["人像"], tags: [], trash_count: 0 },
        read_layout: () => null,
        write_layout: () => undefined,
        asset_thumbnail: () => new Uint8Array(data.thumb).buffer,
        linked_image_states: () => [],
        image_detail: ({ hash }) => {
          const asset = data.assets.find(item => item.hash === hash);
          if (asset === undefined) throw new Error("性能 fixture 中不存在该图片：" + hash);
          return { asset, linked_prompts: [] };
        },
        global_search: () => ({ assets: [], prompts: [] }),
        "plugin:event|listen": () => ++eventId,
        "plugin:event|unlisten": () => undefined,
      };
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback: (callback) => {
          const id = ++callbackId;
          Object.defineProperty(window, "_" + id, { value: callback, configurable: true });
          return id;
        },
        invoke: (command, args) => {
          data.calls.push(command);
          const handler = handlers[command];
          if (handler === undefined) throw new Error("基线桩未覆盖命令：" + command);
          return Promise.resolve(handler(args));
        },
      };
    })();
  `;
}
