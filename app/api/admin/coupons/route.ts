import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { listCouponGrantOptions } from "@/lib/services/adminCoupons";

/**
 * 管理端可发放的优惠券模板：`GET /api/admin/coupons`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 只返回**当前启用**的模板（P1-4 验收整改轮 §四.2）：发出去一张已停用的券，
 * 用户拿到手也核销不了。过滤在服务端做，页面不自己筛。
 *
 * 数据源与用户端领券中心是同一份（`lib/services/coupons.ts` 读同一个仓储），
 * 因此后台看到的券面与前台完全一致，不存在两套券。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);

    return ok(await listCouponGrantOptions(searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
