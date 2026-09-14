import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { queryAdminRefundList, resolveAdminRefundListQuery } from "@/lib/services/adminRefunds";

/**
 * 管理端退款申请列表：`GET /api/admin/refunds`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`，且必须在这里、不在服务层：页面上的隐藏入口
 * 不构成保护，接口是可以被直接请求的。
 *
 * 列表 DTO **不含退款原因、说明、凭证与审核意见**：那些只在详情页展示。
 * 字段裁剪在 `toAdminRefundListItem()`，不在本文件。
 *
 * ⚠️ 关键词**只搜「退款单号 / 订单号 / 用户昵称 / 平台展示 ID」**，不搜退款说明与审核意见：
 * 说明里可能有用户写的隐私信息，把它当搜索对象等于给了一个探测入口。
 *
 * 分页与筛选都由服务层完成；`status` 传了非法值回 400，分页越界走规范化。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminRefundListQuery(searchParams, true);

    return ok(await queryAdminRefundList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
