import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { startCompanionOrder } from "@/lib/services/companionOrders";

/**
 * 开始服务（`accepted → serving`，P0-7）。
 *
 * 权限：`requireCompanion()`，**第一个动作**。`companionId` 只来自会话，
 * 请求体里一个身份字段都不读——「我是哪位打手」在结构上不可能由调用方声明。
 *
 * ## 没有请求体，因此也不解析请求体
 *
 * 这个动作不需要原因、不需要幂等键（幂等的判据是**状态本身**：这一单已经是
 * `serving` 且归本人就是重放，见 `02-decisions.md` D2）。因此本文件**不调用
 * `readJsonBody`**：
 *
 * - 调了它反而会**要求**调用方发一个 JSON 体——空体与 `null` 都会被它判成
 *   「请求体格式无效」400，那就等于给这个接口发明了一条服务端文档里没有的规则；
 * - 「忽略请求体」比「校验请求体」更强：有人塞进 `{ companionId: "别人" }` 时
 *   它不会报错，而是**一点作用都没有**——身份只可能来自 `requireCompanion()`。
 *
 * ## 业务失败走 4xx（与取消同一条取舍）
 *
 * - 非本人实际履约 → **404**（与详情一致，不泄露存在性）；
 * - 是本人的单但状态不是 `accepted` → **400**：`开始服务` 这个入口只会出现在
 *   `accepted` 详情上，出现别种状态说明调用方拿着过期的页面在操作，
 *   而把 `paid` / `completed` / `refunded` 拉进 `serving` 是**绝对错误**的。
 *
 * 「重复点击」不走这条：这一单已经是他的 `serving` 时返回 200 与第一次的结果
 * （`kind: "replayed"`，且**不刷新** `servingAt`）。
 *
 * ## 本接口不做判定
 *
 * 能不能开始（是不是本人、状态是不是还停在 `accepted`）全部在
 * `startCompanionOrder` 的原子区段里判定，并在**同一段**代码里写下 `serving` 与
 * `servingAt`。到这里再判一次，就等于把判定与写入拆开。
 *
 * 本文件只有 POST。
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/companion/orders/[id]/start">,
) {
  try {
    const companion = await requireCompanion();
    const { id } = await context.params;

    return ok(await startCompanionOrder(companion.companionId, id));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
