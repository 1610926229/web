import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminCouponTemplateEnabled } from "@/lib/services/adminCouponTemplates";

/**
 * 停用券模板：`POST /api/admin/coupon-templates/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 停用的后果有三层，都在服务端保证：
 * - 这张券**不能再被领取**（`couponClaimability()` 判定为不可领）；
 * - 它**不能再被后台发放**（`grantCouponToUser()` 直接 400）；
 * - **已经领到手的券也无法再用它核销**（`resolveCouponClaimGate()` 看模板当前的
 *   `enabled`，返回 `disabled`）。
 *
 * ⚠️ **停用不删除任何 Claim**（§5）：用户手里的券还在，「我的优惠券」里也还看得见，
 * 只是多了一句「该券已停用，无法使用」。已产生的订单更是完全不受影响——
 * 那些订单上的券快照是历史事实。
 *
 * ⚠️ **没有前置条件**：已经有多少人领过不是拒绝停用的理由。
 * 那个数字在列表上是给管理员**看的**提示，不是一道闸。
 *
 * 重复停用是幂等的：不写数据、不写第二条审计，返回 `changed: false`。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/coupon-templates/[id]/disable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminCouponTemplateEnabled(id, false, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
