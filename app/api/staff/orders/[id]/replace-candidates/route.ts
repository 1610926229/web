import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { listStaffOrderReplaceCandidates } from "@/lib/services/staffOrderActions";

/**
 * 换人候选名单：`GET /api/staff/orders/[id]/replace-candidates`（P0-11）。
 *
 * ⚠️ 第一件事是 `requireStaff()`。
 *
 * ⚠️ **资格过滤在服务端**：名单里出现的每一位护航都是「指定一定会成功」的
 * （`enabled`、未移除、当前可接单、不是下单用户本人、不是正在履约这一单的那位）。
 * 让前端拿全量护航列表自己筛，等于把资格规则抄进浏览器。
 *
 * ⚠️ 这一单根本没有可换的对象时返回 **400**（与换人接口同一句文案），
 * 而不是一个空名单：「没有人可以换」与「这一单不该有换人按钮」对客服要做的
 * 下一步完全不同。
 *
 * ⚠️ 本接口**只读**，不产生任何写入，也不做惰性物化：它读的是护航名单与订单状态，
 * 两者都不是「会到点自动变化」的事实（到点会变的是派单与完成材料，那两处挂在哪里
 * 由各自的读取路径决定）。
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/staff/orders/[id]/replace-candidates">,
) {
  try {
    await requireStaff();
    const { id } = await context.params;

    return ok(await listStaffOrderReplaceCandidates(id ?? ""));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
