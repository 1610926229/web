import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { ADMIN_COUPON_NOT_FOUND_MESSAGE } from "@/lib/constants/adminCoupons";
import {
  getAdminCouponTemplateDetail,
  updateAdminCouponTemplate,
} from "@/lib/services/adminCouponTemplates";

/**
 * 管理端券模板详情与编辑：`GET` / `PATCH /api/admin/coupon-templates/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 对**已停用**的模板照样返回：后台要能查看并重新启用它。
 * 返回 404 等于把「停用」变成了记录消失，那正是 §6 不肯做硬删除要避免的事。
 *
 * PATCH 是**编辑**而不是「随便改」：它改不了 `formKey`，因此一次普通保存
 * 永远无法把一张折扣券变成满减券——那会同时改变这张券的结算语义（§1）。
 * 非满减券整体不可编辑，服务端返回 400（这句话与列表项上的 `editable: false` 同源）。
 *
 * 校验失败返回 400，message 是**第一条**字段错误。**拒绝，不夹取**：
 * 一条 `threshold = -1` 的输入在这里变成 400，而不是被改成 1 写进去。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/coupon-templates/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminCouponTemplateDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_COUPON_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/coupon-templates/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminCouponTemplate(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
