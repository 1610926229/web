import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { listOrdersForStaff, resolveStaffOrderListQuery } from "@/lib/services/staffOrders";

/**
 * 客服工作台全量订单列表：`GET /api/staff/orders`（P0-10）。
 *
 * ⚠️ 第一件事是 `requireStaff()`（架构规则 §2.2 明确要求）。身份矩阵：
 * 匿名 401、普通用户 Cookie 401、管理 Cookie 401、护航 / 停用 / 已移除客服 403，
 * 只有启用中的客服能通过。理由见 `lib/api/staffRoute.ts`。
 *
 * ⚠️ 本接口**只读**：不改变任何订单状态、不写任何仓储、不产生通知。
 * 客服能查的是「这一单现在是什么状态、是谁在跟」，不是处置它
 * （换人 / 退款属 P0-11 及以后，入口也不在这里）。
 *
 * 支持的查询参数：`status`（订单状态）、`game`（订单里出现过的游戏名）、
 * `from` / `to`（`YYYY-MM-DD`，北京时间自然日）、`keyword`（订单号 / 用户昵称 /
 * 平台标识 / 商品名）、`page` / `pageSize`（越界自动收敛）。
 *
 * 非法 `status` / `game` / `from` / `to` 返回 400，**不静默回退**——地址是用户随手可改的，
 * 但接口是可被直接请求的，两者对非法输入该有不同的反应
 * （页面那条链路用 `strict: false` 规范化）。
 *
 * ⚠️ 返回的列表项**不含**游戏账号、用户备注、售后摘要，也**不含**分账比例与平台收入。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireStaff();
    const { searchParams } = new URL(request.url);
    const query = await resolveStaffOrderListQuery(searchParams, true);

    return ok(await listOrdersForStaff(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
