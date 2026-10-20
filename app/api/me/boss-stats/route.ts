import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { getBossStatsForUser } from "@/lib/services/bossStats";

/**
 * 当前用户的「老板数据」摘要（`/mine` 的老板数据面板用它）。
 *
 * 五个指标：累计订单数 / 累计消费金额 / 最近 30 天消费 / 常玩游戏 Top3 / 常用打手 Top3。
 *
 * 权限：**必须登录**。用户身份只来自服务端会话，接口**不接受任何用户标识参数**，
 * 因此不存在「用别人的 id 查别人数据」的入口——这也是本接口最要紧的一条边界。
 *
 * 响应体是**专用 DTO**（`BossStatsSummary`）：只有五个聚合结果与三句口径说明，
 * 刻意不含订单列表、商品标题、游戏账号、订单备注、分账比例与平台净收入
 * （见 `lib/types/bossStats.ts` 的「最小 DTO」一节）。金额一律是**分**，
 * 由页面用项目现有金额组件格式化。
 *
 * ⚠️ 本文件**只有 GET**。全部指标都是订单与服务历史的派生结果，不接受客户端提交——
 * 接口不提供任何写入口。
 */
export async function GET() {
  try {
    const user = await requireUser();
    return ok(await getBossStatsForUser(user.id));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
