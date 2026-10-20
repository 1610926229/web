import { ADMIN_ORDER_UNFILTERED_QUERY, getPaymentRepository } from "@/lib/data/paymentRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import type { Order } from "@/lib/types/order";
import type { AdminUserSummary } from "@/lib/types/user";

/**
 * 管理端各列表共用的**两个索引**（P1-3 抽出）。
 *
 * ## 为什么单独一个文件
 *
 * 订单 / 退款 / 投诉 / 售后四个管理列表此前各写了一份一模一样的
 * `adminUserIndex` 与 `missingUser`（`adminOrderIndex` 有两份），
 * 四份的实现**逐字节相同**。同形的四份定义没有任何机制保证它们继续相同：
 * 将来 `AdminUserSummary` 多一个字段、或用户仓储的取数方式变了，
 * 只改其中三处不会有任何测试变红——**只会有一个后台页面的用户名列悄悄变空白**。
 * 因此这里不是「顺手整理」，是把那三个函数的**唯一定义**放到一处。
 *
 * ⚠️ 本文件只做「id → 摘要 / 实体」的索引构建，**不含任何业务判断**：
 * 谁该出现在列表里、一条记录读不出来时算不算数，都是各服务自己的规则
 * （例如退款列表跳过找不到订单的申请，而售后工作台保留它并把订单列留空——
 * 这两个相反的处理各自写在各自的文件里，不能因为这层共用而合并）。
 */

/**
 * userId → 用户摘要。
 *
 * 一次取回全部用户而不是逐条查询：列表每页几十行，逐条查会让「一页几次往返」
 * 变成与页大小相关的量。与各服务的做法一致。
 *
 * ⚠️ 摘要**只有** `id` / `displayId` / `nickname` 三项——接口层不再裁剪，
 * 所以这里多放一个字段就等于把它发给了浏览器。
 */
export async function adminUserIndex(): Promise<Map<string, AdminUserSummary>> {
  const users = await getUserRepository().listUsers();
  return new Map(
    users.map((user) => [user.id, { id: user.id, displayId: user.displayId, nickname: user.nickname }]),
  );
}

/**
 * orderId → 订单。
 *
 * ⚠️ 管理端的列表筛选里含**订单号**与**打手昵称**，而这两样都不在退款申请
 * 或投诉自己身上。因此关键词匹配必须在分页**之前**完成，也就必须先把订单取回来——
 * 逐条 `findOrderById` 会让「先翻到第 2 页、再判断这一页命中没有」成为唯一可能的顺序，
 * 那样 `total` 与实际能翻到的条数必然分叉。
 *
 * ⚠️ 它同时也是**打手快照的唯一来源**：取 `order.companion`（订单自己记的那份），
 * 而**不去查派单仓储**——那张表回答的是「谁被派了单 / 用户指定了谁」，
 * 与「这一单实际是谁在做」是两件事（见 `Order.actualCompanionId` 的注释）。
 */
export async function adminOrderIndex(): Promise<Map<string, Order>> {
  const orders = await getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
  return new Map(orders.map((order) => [order.id, order]));
}

/**
 * 用户记录缺失时的占位摘要。
 *
 * 缺一条用户记录不该让整页打不开，因此各列表用它兜底；但**空字符串就是空**——
 * 不编一个「已注销」或占位昵称出来，那会让读到它的人以为真有一个这样的用户。
 */
export function missingUser(userId: string): AdminUserSummary {
  return { id: userId, nickname: "", displayId: "" };
}
