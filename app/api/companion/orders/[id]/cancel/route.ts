import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { cancelCompanionOrder } from "@/lib/services/companionOrders";

/**
 * 主动取消接单（`accepted → paid`，订单回到公共池）。
 *
 * 权限：`requireCompanion()`，**第一个动作**。`companionId` 只来自会话，
 * 请求体里一个身份字段都不读——「我是哪位打手」在结构上不可能由调用方声明。
 *
 * ## 请求体
 *
 * `{ reason, idempotencyKey }`：原因必填（**只 trim + 拒绝空串**，不发明字数规则），
 * 幂等键复用全站现有格式（`lib/constants/writes.ts`）。两个字段的解析与校验都在
 * 服务层（`cancelCompanionOrder`），本文件只把 body 原样交过去——放这里就等于
 * 「哪些字段合法」在接口与服务两处各有一份。
 *
 * ## 业务失败走 4xx，与接单接口的取舍**不同**
 *
 * 接单接口把「刚被别人接走了」当**正常业务结果**返回 200（那是一场平等的抢单）。
 * 这里不是：
 *
 * - 非本人实际履约 → **404**（与详情一致，不泄露存在性）；
 * - 是本人的单但状态已不是 `accepted` → **400**：`取消接单` 这个入口只会出现在
 *   `accepted` 详情上，出现别种状态说明调用方拿着过期的页面在操作，
 *   而把 `serving` / `completed` / `refunded` 拉回 `paid` 是**绝对错误**的（D5）。
 *
 * 「连点两次」不走这条：同一个幂等键第二次到达返回 200 与第一次的结果
 * （`kind: "replayed"`），因此正常的重复提交不会被当成错误。
 *
 * ## 本接口不做判定
 *
 * 能不能取消（是不是本人、状态是不是还停在 `accepted`）全部在
 * `cancelAcceptedOrder` 的原子区段里判定，并在**同一段**代码里写退出历史、
 * 清订单履约绑定、派单回公共池、通知用户。到这里再判一次，就等于把判定与写入拆开。
 *
 * 本文件只有 POST。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/companion/orders/[id]/cancel">,
) {
  try {
    const companion = await requireCompanion();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await cancelCompanionOrder(companion.companionId, id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
