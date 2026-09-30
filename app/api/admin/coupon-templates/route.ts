import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  createAdminCouponTemplate,
  queryAdminCouponTemplateList,
  resolveCouponTemplateListQuery,
} from "@/lib/services/adminCouponTemplates";

/**
 * 管理端券模板列表与新建：`GET` / `POST /api/admin/coupon-templates`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。普通用户、客服、护航与停用管理员
 * 一律 401 / 403 —— 权限判断只有 `lib/api/adminRoute.ts` 一处。
 *
 * ⚠️ 路径是 `coupon-templates` 而不是 `coupons`：那一条已经被**发放**
 * （`/api/admin/coupons/grant`）占用，两者是两件事——发放产生一张 `CouponClaim`，
 * 本接口改的是 `Coupon` 模板本身。
 *
 * GET 返回**全部**券模板（含已停用，`enabled=disabled` 筛出后者）：
 * 「后台看不到自己停用过哪张券」是不行的——停用必须是可回查的状态。
 *
 * POST 的可改字段就是 `AdminCouponTemplateProfilePatch` 那些（名称、门槛、优惠金额、
 * 有效期、启用状态）。`id`、`createdAt`、`updatedAt`、`formKey`、`formLabel`、
 * `valueLabel`、`conditionLabel` 在服务端**没有读取的位置**，客户端多传一个也不会有
 * 任何效果（§九：客户端伪造 ID、状态、时间、文案必须被忽略；§3：文案由金额派生）。
 *
 * 数据源只有一份：本接口与用户端领券中心读的是同一个仓储。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = resolveCouponTemplateListQuery(searchParams, true);

    return ok(await queryAdminCouponTemplateList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await createAdminCouponTemplate(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
