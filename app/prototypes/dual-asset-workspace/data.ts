export type LibraryKind = "images" | "prompts";
export type ViewKind = "masonry" | "details";

export type ImageFixture = {
  id: string;
  name: string;
  width: number;
  height: number;
  folder: string;
  tags: string[];
  note: string;
  favorite: boolean;
  hue: number;
};

export type PromptFixture = {
  id: string;
  title: string | null;
  text: string;
  folder: string;
  tags: string[];
  note: string;
  favorite: boolean;
  model: string | null;
  linkedImageIds: string[];
  coverImageId: string | null;
};

const imageFolders = ["根文件夹", "人物/室内", "构图/广角", "配色/低饱和", "UI/仪表盘"];
const promptFolders = ["根文件夹", "人像/室内", "动漫/角色", "商业/产品", "常用/光线"];
const tagPairs = [
  ["人物", "逆光"],
  ["赛博朋克", "夜景"],
  ["构图", "广角"],
  ["动漫", "蓝色"],
  ["产品", "影棚"],
] as const;
const promptBodies = [
  "cinematic indoor portrait, soft window light, subtle rim lighting, restrained contrast, natural skin texture",
  "cyberpunk city at night, rain-soaked streets, layered neon signage, deep perspective, quiet solitary figure",
  "wide-angle architectural composition, strong foreground anchor, repeating geometry, soft overcast illumination",
  "anime character illustration, clean linework, cool ambient palette, expressive silhouette, controlled cel shading",
  "minimal commercial product still life, precise reflections, neutral backdrop, tactile materials, editorial spacing",
];

function ratioFor(index: number): readonly [number, number] {
  const ratios = [
    [4, 5],
    [3, 2],
    [1, 1],
    [9, 16],
    [16, 9],
    [5, 7],
  ] as const;
  return ratios[index % ratios.length] ?? ratios[0];
}

export const imageFixtures: ImageFixture[] = Array.from({ length: 10_000 }, (_, index) => {
  const [rw, rh] = ratioFor(index);
  const tagPair = tagPairs[index % tagPairs.length] ?? tagPairs[0];
  return {
    id: `image-${index}`,
    name: `visual_reference_${String(index + 1).padStart(5, "0")}.png`,
    width: rw * 320,
    height: rh * 320,
    folder: imageFolders[index % imageFolders.length] ?? "根文件夹",
    tags: [...tagPair],
    note: index % 4 === 0 ? "留意画面边缘的光线过渡和主体留白。" : "",
    favorite: index % 17 === 0,
    hue: (index * 47) % 360,
  };
});

export const promptFixtures: PromptFixture[] = Array.from({ length: 10_000 }, (_, index) => {
  const linkedImageIds = index % 4 === 0
    ? []
    : Array.from({ length: (index % 5) + 1 }, (__, offset) => `image-${(index * 7 + offset) % 10_000}`);
  const tagPair = tagPairs[index % tagPairs.length] ?? tagPairs[0];
  const base = promptBodies[index % promptBodies.length] ?? promptBodies[0];
  return {
    id: `prompt-${index}`,
    title: index % 6 === 0 ? null : `视觉方案 ${String(index + 1).padStart(4, "0")}`,
    text: `${base}. Variation ${index + 1}, preserve subject hierarchy and material response while allowing secondary details to vary.`,
    folder: promptFolders[index % promptFolders.length] ?? "根文件夹",
    tags: [...tagPair],
    note: index % 7 === 0 ? "外部模型测试时保留画幅与材质词。" : "",
    favorite: index % 13 === 0,
    model: index % 3 === 0 ? null : ["Midjourney", "Krea", "ComfyUI"][index % 3] ?? null,
    linkedImageIds,
    coverImageId: linkedImageIds[0] ?? null,
  };
});

// 以下只是可丢弃原型的用户自定义示例，不是产品固定分类。
export const imageFolderFixtures = imageFolders;
export const promptFolderFixtures = promptFolders;
export const tagFixtures = Array.from(new Set(tagPairs.flat()));
