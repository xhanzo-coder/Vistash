/**
 * 应用级 seam 共用的最小类型（任务 6.1，设计第三条）。
 *
 * 只放真正跨 seam 的名字。宁可多一个小文件，也不让导航、任务中心与平台 port
 * 这三个互不依赖的 seam 彼此导入。
 */

/** 一个拉取式订阅的取消函数。调用后不得再向订阅者投递任何信号。 */
export type Unsubscribe = () => void;

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
