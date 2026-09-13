import { fail, ok, toApiError } from "@/lib/api/route";
import { requireUser } from "@/lib/api/route";
import { withdrawCompanionApplicationForUser } from "@/lib/services/companionApplications";

/**
 * 撤销一条护航入驻申请。
 *
 * 权限：必须登录，且**只有申请人本人**能撤销。申请不存在、或不属于当前用户时
 * 走的是同一个分支，对外返回**同一个 404**——拿别人的申请 id 来试探因此得不到
 * 任何信息（分不出「不存在」与「存在但不是你的」）。
 *
 * 三条规则由服务端保证（详见 `lib/services/companionApplications.ts`）：
 * - 只有「待查看」可以撤销，其余状态返回 400；
 * - 重复撤销幂等：返回同一条记录，不会再产生一次变更；
 * - **只改状态，不删除记录**——用户仍然要能在进度页看到自己提交过什么。
 *
 * 这个接口是撤销的**唯一**入口，请求体里没有任何字段：改什么由路径决定，
 * 状态改成什么由服务端决定。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/companion-applications/[id]/withdraw">,
) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    return ok(await withdrawCompanionApplicationForUser(user.id, id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
