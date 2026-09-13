import { apiGet } from "@/lib/api/client";
import { COMPANION_PAGE_SIZE, type CompanionAvailability } from "@/lib/constants/companions";
import type { CompanionPage } from "@/lib/types/companion";

/**
 * 陪玩的**浏览器端**取数（筛选、搜索、翻页与「加载更多」）。
 *
 * 与服务端模块 `lib/services/companions.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 列表与详情的首屏由 Server Component 直接取数，不经过本文件。
 *
 * ⚠️ 请求里**只有筛选与分页参数**，没有任何用户标识：陪玩名单是公开内容，
 * 「我是谁」由会话决定，不由调用方声明。
 */

export type CompanionListRequest = {
  keyword?: string;
  /** 空串表示全部游戏 */
  gameId?: string;
  availability?: CompanionAvailability;
  page?: number;
  pageSize?: number;
};

/** 取一页公开陪玩列表。 */
export function fetchCompanions(input: CompanionListRequest = {}): Promise<CompanionPage> {
  const params = new URLSearchParams();
  // 只在有筛选条件时才带上参数：`?keyword=&gameId=` 这类空参数会让地址栏与日志里
  // 多出一堆无意义的键，排查问题时反而更难读
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.gameId) params.set("gameId", input.gameId);
  if (input.availability) params.set("availability", input.availability);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? COMPANION_PAGE_SIZE));

  return apiGet<CompanionPage>(`/api/companions?${params.toString()}`);
}
