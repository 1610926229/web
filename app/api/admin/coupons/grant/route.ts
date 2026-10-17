import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { grantCouponToUser } from "@/lib/services/adminCoupons";

/**
 * 管理员向指定用户发放优惠券：`POST /api/admin/coupons/grant`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`，而且发放人**只**取 `requireAdmin()` 返回的
 * 会话身份——请求体里没有、也不接受 `grantedByAdminId`。
 * 「谁发的」这一条审计如果能让调用方自己声明，它就不再是审计。
 *
 * 请求体只读三个字段：`userId`、`couponId`、`idempotencyKey`。
 * 金额、门槛、有效期一概不由请求体决定——它们取**当前模板**的快照
 * （P1-4 验收整改轮 §七）。
 *
 * ⚠️ 发放**不受**「同一用户对同一模板只能领一次」约束（§五）：可以重复发、
 * 可以对已领过的人再发。每次调用生成一张独立的 Claim，各自只能核销一次。
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await grantCouponToUser(admin.id, body, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
