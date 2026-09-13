import { apiGet } from "@/lib/api/client";
import { TIP_PAGE_SIZE } from "@/lib/constants/tips";
import type { TipPage, TipStatusFilter } from "@/lib/types/tip";

/**
 * 鸡腿记录的**浏览器端**取数（切换状态筛选与加载更多）。
 *
 * 与服务端模块 `lib/services/tips.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 列表首屏由 Server Component 直接取数，不经过本文件。
 *
 * ⚠️ 这里**只有读**。本阶段没有「送鸡腿」的接口——价格、兑换比例、支付方式与结算规则
 * 都还没有确认（原因见 `lib/services/tips.ts`），因此客户端连一个可调用的写入口都没有。
 */

export type TipListRequest = {
  status: TipStatusFilter;
  page?: number;
  pageSize?: number;
};

/** 当前用户的鸡腿记录。 */
export function fetchTips(input: TipListRequest): Promise<TipPage> {
  const params = new URLSearchParams();
  params.set("status", input.status);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? TIP_PAGE_SIZE));

  return apiGet<TipPage>(`/api/tips?${params.toString()}`);
}
