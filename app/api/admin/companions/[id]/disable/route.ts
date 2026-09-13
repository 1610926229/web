import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminCompanionFlags } from "@/lib/services/adminCompanions";

/**
 * 停用：`POST /api/admin/companions/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 停用的后果是**对用户端完全消失**：公开列表查不到、结算页选不中，
 * 直接访问详情链接只会看到只读的「该护航暂不提供服务」。
 * 这与「暂停接单」不同——暂停仍然公开展示，只是不能下单。
 *
 * 服务端同时把 `available` 置为 `false`（启用状态与可接单状态不允许出现
 * 「停用但可接单」这种组合），因此这里不需要客户端传可接单状态。
 *
 * ⚠️ **不删除任何历史**：订单、评价、鸡腿记录都还在。停用是状态变化，不是数据清理；
 * 真要让人彻底从名单里消失用的是「移除」。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companions/[id]/disable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminCompanionFlags(id, "disable", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
