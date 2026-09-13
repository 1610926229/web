import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { queryTipsForUser } from "@/lib/services/tips";

/**
 * 鸡腿记录列表接口（浏览器端切换状态筛选与加载更多时调用）。
 *
 * 权限：必须登录；用户身份只来自服务端会话，接口不接受任何「查谁的记录」参数。
 *
 * 参数契约（详见 `lib/constants/tips.ts`）：
 * - `status` 只能是 `all` / `paid` / `pending` / `failed`，其余取值 → 400，不静默回退；
 * - `page` / `pageSize` 非数字或越界 → 规范化到安全范围。
 *
 * ⚠️ 本文件**只有 GET**。本阶段不提供「送鸡腿」的写接口：鸡腿的价格、兑换比例、
 * 支付方式与打手结算规则都还没有确认，不提供写入口也就不会顺带定下这些口径
 * （原因见 `lib/services/tips.ts`）。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await queryTipsForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
