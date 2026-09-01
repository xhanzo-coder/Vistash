import { expect, test, vi } from "vitest";

import { parseAssetId, parseLibraryId } from "../../app/common";
import { createWorkspaceNavigation } from "../../app/navigation";
import {
  createImagePromptRelations,
  type ImagePromptRelationAdapter,
  type RelationTarget,
} from "./index";

const LIB_A = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000a1");
const LIB_B = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000b2");
const IMAGE = parseAssetId("a".repeat(64));

test("关系写入等待当前库的全部刷新 Adapter，再兑现成功", async () => {
  const link = vi.fn(async (_promptId: string, _images: readonly string[]) => {});
  const resolve = vi.fn(async (target: RelationTarget): Promise<RelationTarget> => target);
  const adapter: ImagePromptRelationAdapter = {
    link,
    unlink: vi.fn(async () => {}),
    setCover: vi.fn(async () => {}),
    resolve,
  };
  const navigation = createWorkspaceNavigation();
  const relations = createImagePromptRelations({ adapter, navigation });
  const assetRefresh = vi.fn(async () => {});
  const promptRefresh = vi.fn(async () => {});
  const otherLibraryRefresh = vi.fn(async () => {});
  relations.registerRefresh(LIB_A, assetRefresh);
  relations.registerRefresh(LIB_A, promptRefresh);
  relations.registerRefresh(LIB_B, otherLibraryRefresh);

  const commit = await relations.execute({
    kind: "link",
    libraryId: LIB_A,
    images: [IMAGE],
    prompts: ["prompt-a"],
  });

  expect(link).toHaveBeenCalledWith("prompt-a", [IMAGE]);
  expect(commit).toEqual({ succeeded: 1, failures: [], refreshError: null });
  expect(assetRefresh).toHaveBeenCalledWith({ imageIds: [IMAGE], promptIds: ["prompt-a"] });
  expect(promptRefresh).toHaveBeenCalledWith({ imageIds: [IMAGE], promptIds: ["prompt-a"] });
  expect(otherLibraryRefresh).not.toHaveBeenCalled();

  await relations.open({ kind: "prompt", libraryId: LIB_A, id: "prompt-a", location: "trash" });
  expect(resolve).toHaveBeenCalledWith({ kind: "prompt", libraryId: LIB_A, id: "prompt-a", location: "trash" });
  expect(navigation.active).toBe("prompts");
  expect(navigation.entryFor("prompts")).toMatchObject({
    kind: "locate_prompt",
    promptId: "prompt-a",
    location: "trash",
  });
});

test("批量建立关联逐提示词隔离失败，只有成功写入才刷新", async () => {
  const adapter: ImagePromptRelationAdapter = {
    link: async (promptId) => {
      if (promptId === "prompt-b") throw { code: "library.prompt_write_failed", detail: "只读侧车" };
    },
    unlink: vi.fn(async () => {}),
    setCover: vi.fn(async () => {}),
    async resolve(target) { return target; },
  };
  const relations = createImagePromptRelations({ adapter, navigation: createWorkspaceNavigation() });
  const refresh = vi.fn(async () => {});
  relations.registerRefresh(LIB_A, refresh);
  const partial = await relations.execute({ kind: "link", libraryId: LIB_A, images: [IMAGE], prompts: ["prompt-a", "prompt-b"] });
  expect(partial).toMatchObject({ succeeded: 1, failures: [{ promptId: "prompt-b", error: { code: "library.prompt_write_failed" } }], refreshError: null });
  expect(refresh).toHaveBeenCalledTimes(1);

  const failed = await relations.execute({ kind: "link", libraryId: LIB_A, images: [IMAGE], prompts: ["prompt-b"] });
  expect(failed.succeeded).toBe(0);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("权威写入成功但刷新失败时保留提交结果并返回稳定刷新错误", async () => {
  const adapter: ImagePromptRelationAdapter = {
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    setCover: vi.fn(async () => {}),
    async resolve(target) { return target; },
  };
  const relations = createImagePromptRelations({ adapter, navigation: createWorkspaceNavigation() });
  relations.registerRefresh(LIB_A, async () => {
    throw { code: "library.io_failed", detail: "图片详情读取失败" };
  });

  const commit = await relations.execute({ kind: "link", libraryId: LIB_A, images: [IMAGE], prompts: ["prompt-a"] });

  expect(commit).toEqual({
    succeeded: 1,
    failures: [],
    refreshError: { code: "library.io_failed", detail: "图片详情读取失败" },
  });
});

test("目标永久删除时不导航，返回缺失错误并刷新两侧关系", async () => {
  const adapter: ImagePromptRelationAdapter = {
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    setCover: vi.fn(async () => {}),
    resolve: vi.fn(async () => {
      throw { code: "prompt.not_found", detail: "目标已永久删除" };
    }),
  };
  const navigation = createWorkspaceNavigation();
  const relations = createImagePromptRelations({ adapter, navigation });
  const refresh = vi.fn(async () => {});
  relations.registerRefresh(LIB_A, refresh);

  await expect(relations.open({ kind: "prompt", libraryId: LIB_A, id: "prompt-a", location: "trash" })).rejects.toMatchObject({
    appError: { code: "prompt.not_found" },
  });
  expect(refresh).toHaveBeenCalledWith({ imageIds: [], promptIds: ["prompt-a"] });
  expect(navigation.active).toBe("assets");
});

test("外部权威变化进入同一刷新协调，不绕过按库隔离", async () => {
  const adapter: ImagePromptRelationAdapter = {
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    setCover: vi.fn(async () => {}),
    async resolve(target) { return target; },
  };
  const relations = createImagePromptRelations({ adapter, navigation: createWorkspaceNavigation() });
  const refreshA = vi.fn(async () => {});
  const refreshB = vi.fn(async () => {});
  relations.registerRefresh(LIB_A, refreshA);
  relations.registerRefresh(LIB_B, refreshB);

  const error = await relations.synchronize(LIB_A, { imageIds: [IMAGE], promptIds: ["prompt-a"] });

  expect(error).toBeNull();
  expect(refreshA).toHaveBeenCalledWith({ imageIds: [IMAGE], promptIds: ["prompt-a"] });
  expect(refreshB).not.toHaveBeenCalled();
});

test("同库关系写入与刷新严格串行，旧读取不能在新写入后覆盖界面", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const calls: string[] = [];
  const adapter: ImagePromptRelationAdapter = {
    async link(promptId) {
      calls.push(`write:${promptId}`);
      if (promptId === "prompt-a") await firstGate;
    },
    unlink: vi.fn(async () => {}),
    setCover: vi.fn(async () => {}),
    async resolve(target) { return target; },
  };
  const relations = createImagePromptRelations({ adapter, navigation: createWorkspaceNavigation() });
  relations.registerRefresh(LIB_A, async (change) => { calls.push(`refresh:${change.promptIds[0]}`); });

  const first = relations.execute({ kind: "link", libraryId: LIB_A, images: [IMAGE], prompts: ["prompt-a"] });
  const second = relations.execute({ kind: "link", libraryId: LIB_A, images: [IMAGE], prompts: ["prompt-b"] });
  await Promise.resolve();
  expect(calls).toEqual(["write:prompt-a"]);

  releaseFirst();
  await Promise.all([first, second]);
  expect(calls).toEqual(["write:prompt-a", "refresh:prompt-a", "write:prompt-b", "refresh:prompt-b"]);
});
