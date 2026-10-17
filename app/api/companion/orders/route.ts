import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { listCompanionOrders } from "@/lib/services/companionOrders";

/**
 * 当前打手「我的订单」列表。
 *
 * 权限：`requireCompanion()` —— 未登录 401；登录了但名下没有有效护航资料、
 * 或资料已下架，都是 403。**这一步必须是第一个动作**：页面上的隐藏区不是保护，
 * 接口可以被直接请求。
 *
 * ⚠️ `companionId` **只能**来自 `requireCompanion()` 的会话身份。本接口不读请求体、
 * 不读查询参数——`GET` 连参数都不接。因此不存在「查别人的订单」这种可能。
 *
 * 返回的是**已经按他收窄过的**列表（归属条件是 `Order.actualCompanionId`），
 * 不是「全部订单 + 一个过滤字段」：调用方拿不到不属于他的单，也就不可能因为漏过滤
 * 而看到它们。`exclusiveCompanionId` 在这里不构成归属。
 *
 * ⚠️ 响应里没有平台金额域、用户 id、管理员备注与售后摘要（见 `CompanionOrderListItem`）。
 *
 * 本文件只有 GET。
 */
export async function GET() {
  try {
    const companion = await requireCompanion();

    return ok(await listCompanionOrders(companion.companionId));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
