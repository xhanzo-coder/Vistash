/**
 * 应用级 seam 共用的最小类型。
 *
 * 只放真正跨 seam 的名字。宁可多一个小文件，也不让导航、任务中心与平台 port
 * 这三个互不依赖的 seam 彼此导入。
 */

/** 一个拉取式订阅的取消函数。调用后不得再向订阅者投递任何信号。 */
export type Unsubscribe = () => void;

declare const libraryIdBrand: unique symbol;
declare const assetIdBrand: unique symbol;

/** 通过后端兼容性门禁后取得的稳定库标识。 */
export type LibraryId = string & { readonly [libraryIdBrand]: "LibraryId" };

/** BLAKE3 内容哈希形式的素材标识；它不是路径、文件名或库标识。 */
export type AssetId = string & { readonly [assetIdBrand]: "AssetId" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLAKE3_PATTERN = /^[0-9a-f]{64}$/;

/** 在 IPC DTO 与应用模块的边界校验并品牌化库标识。 */
export function parseLibraryId(value: string): LibraryId {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`库标识不是规范 UUID：${value}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 上面的规范 UUID 校验就是该品牌的运行时构造条件。
  return value as LibraryId;
}

/** 在 IPC DTO 与应用模块的边界校验并品牌化素材内容哈希。 */
export function parseAssetId(value: string): AssetId {
  if (!BLAKE3_PATTERN.test(value)) {
    throw new TypeError(`素材标识不是 64 位小写 BLAKE3 哈希：${value}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 上面的 64 位小写十六进制校验就是该品牌的运行时构造条件。
  return value as AssetId;
}

/**
 * 一次跨模块请求的唯一标识（规范 UUID 字面值）。
 *
 * 导航条目会一直留在状态里供重新呈现读取（渲染必须幂等，不能"取走即清"），
 * 模块靠比较 requestId 识别"这是不是我已经处理过的那条"，过期的重复投递被
 * 自然忽略——这是 StrictMode 双重渲染安全的关键。
 */
export type RequestId = string;

/** 生成请求 ID。格式与后端的规范 UUID 字面值同一规则。 */
export function createRequestId(): RequestId {
  return crypto.randomUUID();
}
