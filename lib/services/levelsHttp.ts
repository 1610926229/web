import { apiGet } from "@/lib/api/client";
import type { ConsumptionLevelSummary } from "@/lib/types/level";

/**
 * 消费等级摘要的**浏览器端**取数。
 *
 * 服务端模块 `lib/services/levels.ts` 依赖 `lib/data` 与 `lib/mocks`，一旦被客户端组件
 * 引用，Mock 层与内存存储就会被打进浏览器产物，因此两侧必须分开。
 *
 * `/rights` 的首屏由 Server Component 直接取数，不经过本文件；本文件只服务
 * `/mine` 的等级卡片：那张卡片是页面的一个局部，取数失败时应当**只让卡片降级**
 * 并给出独立重试，而不是把整个「我的」页打挂——所以它必须能在浏览器端单独重取。
 */

/** 当前用户的消费等级摘要（需要登录）。 */
export function fetchConsumptionLevel(): Promise<ConsumptionLevelSummary> {
  return apiGet<ConsumptionLevelSummary>("/api/me/consumption-level");
}
