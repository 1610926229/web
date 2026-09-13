import { fail, ok, toApiError } from "@/lib/api/route";
import { queryCompanionPage, resolveCompanionListQuery } from "@/lib/services/companions";

/**
 * 公开陪玩列表接口（浏览器端筛选、搜索与「加载更多」时调用）。
 *
 * 权限：**游客可访问**。陪玩名单是浏览型内容，因此这里**不调用 `requireUser()`**——
 * 没有任何需要登录才能做的事，也就没有理由拦人。
 *
 * 参数契约（详见 `lib/constants/companions.ts`）：
 * - `keyword` 为空表示不搜索，匹配昵称 / 自我介绍 / 服务标签；
 * - `gameId` 不传或为空表示全部游戏；**传了不存在的游戏回 400**；
 * - `availability` 只能是 `all` / `available` / `unavailable`，**传了别的值回 400**；
 * - `page` / `pageSize` 非数字或越界 → 规范化到安全范围。
 *
 * 枚举值报错、分页值规范化，这个区别是有意的：分页参数不是用户填写的业务内容，
 * 一个坏掉的页码让整页报错没有意义；而筛选条件是明确的业务条件，写错必须报错——
 * 静默把非法值当成「全部」返回，调用方会拿着「不知道筛了什么」的结果继续往下用。
 *
 * 响应里没有价格、佣金、排期、联系方式，也没有任何用户标识：陪玩定价与订单绑定规则
 * 尚未确认，接口不先给出一个看起来像定价的数字。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    // 接口侧用严格模式：非法枚举抛 400，由 fail() 包成错误信封
    const query = await resolveCompanionListQuery(searchParams, true);

    return ok(await queryCompanionPage(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
