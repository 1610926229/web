import { apiGet } from "@/lib/api/client";
import type { BossStatsSummary } from "@/lib/types/bossStats";

/**
 * 老板数据摘要的**浏览器端**取数。
 *
 * 服务端模块 `lib/services/bossStats.ts` 依赖 `lib/data` 与 `lib/mocks`，一旦被客户端组件
 * 引用，Mock 层与内存存储就会被打进浏览器产物，因此两侧必须分开（与 `levelsHttp.ts` 同一纪律）。
 *
 * `/mine` 的首屏由 Server Component 直接取数，不经过本文件；本文件只服务那块面板的
 * **局部重试**：面板取数失败应当只让这一块降级，而不是把整个「我的」页打挂。
 */

/** 当前用户的老板数据摘要（需要登录）。 */
export function fetchBossStats(): Promise<BossStatsSummary> {
  return apiGet<BossStatsSummary>("/api/me/boss-stats");
}
