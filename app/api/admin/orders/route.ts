import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { queryAdminOrderList, resolveAdminOrderListQuery } from "@/lib/services/adminOrders";

/**
 * 管理端全量订单列表：`GET /api/admin/orders`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`，且必须在这里、不在服务层：页面上的隐藏入口
 * 不构成保护，接口是可以被直接请求的。
 *
 * 列表 DTO **不含游戏账号、备注、增值服务明细与四份售后摘要**（§订单管理）：
 * 想看那些必须进详情页。字段裁剪在 `toAdminOrderListItem()`，不在本文件——
 * DTO 的形状只有一处定义。
 *
 * 分页与筛选都由服务层完成：`page` / `pageSize` 越界规范化，
 * `status` / `game` / `from` / `to` 传了非法值回 400——**静默按「不限」处理会让调用方
 * 拿着与筛选栏不符的结果往下用**。
 *
 * ⚠️ **内部支付请求不在本接口**：支付失败与取消只留下支付请求记录，它们不是订单。
 * 本阶段也不提供支付请求的列表接口，理由见 `ADMIN_ORDER_PAYMENT_NOTICE`。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminOrderListQuery(searchParams, true);

    return ok(await queryAdminOrderList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
