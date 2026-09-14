import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import {
  listConversationsForStaff,
  resolveStaffConversationListQuery,
} from "@/lib/services/staffConversations";

/**
 * 客服工作台会话列表：`GET /api/staff/conversations`。
 *
 * ⚠️ 第一件事是 `requireStaff()`（§六 明确要求）。身份矩阵：
 * 匿名 401、普通用户 Cookie 401、管理 Cookie 401、护航 / 停用 / 已移除客服 403，
 * 只有启用中的客服能通过。理由见 `lib/api/staffRoute.ts`。
 *
 * 支持的查询参数：`keyword`（订单号 / 用户昵称 / 商品名，只去空白不截断）、
 * `unread=1`（只看未读）、`status`（订单状态）、`page` / `pageSize`（越界自动收敛）。
 * 非法 `status` 返回 400——地址是用户随手可改的，但接口是可被直接请求的，
 * 两者对非法输入该有不同的反应（页面那条链路用 `strict: false` 规范化）。
 *
 * ⚠️ 返回的列表项**不含**游戏 ID、订单备注与完整消息历史。
 */
export async function GET(request: Request) {
  try {
    const staff = await requireStaff();
    const { searchParams } = new URL(request.url);
    const query = resolveStaffConversationListQuery(searchParams, true);

    return ok(await listConversationsForStaff(staff.id, query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
