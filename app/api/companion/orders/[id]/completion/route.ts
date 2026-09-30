import { requireCompanion } from "@/lib/api/companionRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { submitCompanionCompletion } from "@/lib/services/companionCompletions";

/**
 * 打手提交完成材料（P0-8）：`POST /api/companion/orders/[id]/completion`。
 *
 * 权限：`requireCompanion()`，**第一个动作**。`companionId` 只来自会话，
 * 请求体里一个身份字段都不读——「我是哪位打手」在结构上不可能由调用方声明。
 *
 * ## 有请求体，因此必须解析它
 *
 * 完成说明与凭证都在请求体里（与开始服务那个「无体」动作刻意不同）。请求体只读
 * `summary` 与 `evidence` 两个字段，长度与格式在服务层校验，这里**不做判定**。
 *
 * ## 业务失败走 4xx（与取消 / 开始服务同一条取舍）
 *
 * - 订单不存在 / 不是本人实际履约 → **404**（两种表现一致，不泄露存在性）；
 * - 是本人的单但状态不是 `serving` → **400**（点了此刻不该存在的按钮）；
 * - 已有 pending 完成材料 → **400**（同一订单最多一份待审核材料）。
 *
 * ## 本接口不做判定
 *
 * 能不能提交（是不是本人、状态是不是 serving、有没有别的 pending）全部在
 * `submitCompletion` 的原子区段里判定，并在**同一段**代码里冻结快照、写入 submission。
 * 到这里再判一次，就等于把判定与写入拆开。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/companion/orders/[id]/completion">,
) {
  try {
    const companion = await requireCompanion();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await submitCompanionCompletion(companion.companionId, id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
