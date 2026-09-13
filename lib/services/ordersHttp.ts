import { apiGet } from "@/lib/api/client";
import { ORDER_PAGE_SIZE } from "@/lib/constants/orders";
import type { PageResult } from "@/lib/types/common";
import type { OrderListItem } from "@/lib/types/order";

/**
 * 订单列表的**浏览器端**取数（切换状态 / 搜索 / 加载更多）。
 *
 * 与服务端模块 `lib/services/orders.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 *
 * 首屏由 Server Component 直接取数，不经过本文件；详情页也完全由服务端渲染，
 * 因此这里只有列表一个函数——不为「用不上」的调用造接口。
 */

export type OrderListRequest = {
  /** 订单状态；空串表示「全部」 */
  status: string;
  /** 订单号关键字；空串表示不搜索 */
  keyword: string;
  page?: number;
  pageSize?: number;
};

export function fetchOrders(input: OrderListRequest): Promise<PageResult<OrderListItem>> {
  const params = new URLSearchParams();
  // 空值不发送：接口把「参数缺失」与「显式空值」都当作「全部 / 不搜索」
  if (input.status) params.set("status", input.status);
  if (input.keyword) params.set("keyword", input.keyword);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ORDER_PAGE_SIZE));

  return apiGet<PageResult<OrderListItem>>(`/api/orders?${params.toString()}`);
}
