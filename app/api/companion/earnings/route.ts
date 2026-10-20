import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { listCompanionEarnings } from "@/lib/services/companionEarnings";

/**
 * 当前打手「我的收益」列表（P0-9）。
 *
 * 权限：`requireCompanion()` —— 未登录 401；登录了但名下没有有效护航资料、
 * 或资料已下架，都是 403。**这一步必须是第一个动作**：页面上的隐藏区不是保护，
 * 接口可以被直接请求。
 *
 * ⚠️ `companionId` **只能**来自 `requireCompanion()` 的会话身份。本接口不读请求体、
 * 不读查询参数——`GET` 连参数都不接。因此不存在「看别人的收益」这种参数位。
 *
 * 返回的是**已经按他收窄过的**列表（归属条件是 `Earning.companionId`）。
 * 响应里没有平台净收入、没有订单的其余金额域、没有提现字段
 * （见 `CompanionEarningItem`）。
 *
 * 本文件只有 GET：本阶段**没有任何写入口**（不做提现、不做余额调整，§十三）。
 */
export async function GET() {
  try {
    const companion = await requireCompanion();

    return ok(await listCompanionEarnings(companion.companionId));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
