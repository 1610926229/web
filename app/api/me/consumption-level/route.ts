import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { getConsumptionLevelForUser } from "@/lib/services/levels";

/**
 * 当前用户的消费等级摘要（`/rights` 与 `/mine` 的等级卡片都用它）。
 *
 * 权限：**必须登录**。用户身份只来自服务端会话，接口不接受任何用户标识参数，
 * 因此不存在「用别人的 id 查别人等级」的入口。
 *
 * 响应体是**专用 DTO**：只有金额、当前/下一等级、差额、进度与等级列表，
 * 刻意不含订单列表、游戏 ID、订单备注、退款原因等订单明细——
 * 页面要的是「我现在什么等级、还差多少」，不是「我买过什么」。
 * DTO 由 `buildConsumptionLevelSummary` 统一产出，页面不自己遍历订单计算。
 *
 * ⚠️ 本文件**只有 GET**。累计消费金额永远是订单的派生结果，等级配置由管理者在
 * 后续 PC 管理后台维护，两者都不接受客户端提交——接口不提供任何写入口。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await getConsumptionLevelForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
