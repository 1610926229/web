import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { approveStaffCompletion } from "@/lib/services/staffCompletions";

/**
 * 客服通过完成材料：`POST /api/staff/completions/[id]/approve`。
 *
 * ⚠️ 第一件事是 `requireStaff()`，且必须在读请求体之前。
 *
 * ## 没有请求体，因此也不解析请求体
 *
 * 这个动作没有原因、没有幂等键（幂等的判据是**状态本身**：submission 已经是
 * `approved` 就是重放），也没有任何需要调用方声明的字段——审核人三个字段写的是
 * 客服会话身份。因此本文件**不调用 `readJsonBody`**：
 *
 * - 调了它反而会**要求**调用方发一个 JSON 体——空体与 `null` 都会被它判成
 *   「请求体格式无效」400，那就等于给这个接口发明了一条服务端文档里没有的规则；
 * - 「忽略请求体」比「校验请求体」更强：有人塞进 `{ staffId: "别人" }` 时
 *   它不会报错，而是**一点作用都没有**——身份只可能来自 `requireStaff()`。
 *
 * ## 通过会同时把订单推进到 completed
 *
 * 这是订单从 `serving → completed` 的唯一入口之一（另一个是到期自动通过）。
 * 判定（pending + 订单 serving + 打手一致）与写入都在 `approveCompletion` 的
 * 原子区段里，本接口不做判定。
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: RouteContext<"/api/staff/completions/[id]/approve">,
) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;

    return ok(await approveStaffCompletion(id ?? "", staff));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
