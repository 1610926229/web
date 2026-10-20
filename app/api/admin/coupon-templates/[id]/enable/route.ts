import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminCouponTemplateEnabled } from "@/lib/services/adminCouponTemplates";

/**
 * 启用券模板：`POST /api/admin/coupon-templates/[id]/enable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 启用的后果：这张券重新出现在领券中心、可以被后台发放，**并且已经领到手但还没用掉的
 * 券重新可以核销**——`resolveCouponClaimGate()` 看的是模板**当前**的 `enabled`，
 * 而不是领取那一刻的值。这一点与「编辑不追溯」是两件事：
 *
 * | 问题 | 由谁回答 | 会不会追溯 |
 * |---|---|---|
 * | 这张券**长什么样**（面额 / 文案 / 有效期） | `CouponClaim.snapshot` | **不会**：领取那一刻冻结 |
 * | 平台**现在还要不要兑现它** | `Coupon.enabled` | **会**：这是当下的开关 |
 *
 * 停用与启用是同一个开关的两端，因此「停用后重新启用即可恢复」是成立的。
 *
 * 重复启用是幂等的：不写数据、不写第二条审计，返回 `changed: false`。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/coupon-templates/[id]/enable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminCouponTemplateEnabled(id, true, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
