import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { getMyCompanionApplicationDetail } from "@/lib/services/companionApplications";

/**
 * 当前用户的护航入驻申请。
 *
 * 权限：必须登录。**没有申请返回 `{ application: null }`**，而不是 404——
 * 「还没有申请」是正常状态，用错误码表达会让前端把一个正常分支写成异常处理。
 *
 * 没有任何「查谁的申请」参数：用户身份只来自服务端会话，因此不可能通过改参数读到
 * 别人的申请。响应里也没有 `userId`，且只有**申请人本人**能看到表单内容与凭证。
 *
 * 本文件只有 GET：申请由 `POST /api/companion-applications` 创建，
 * 由 `POST /api/companion-applications/[id]/withdraw` 撤销，
 * 审核状态的修改**没有任何接口**。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok({
      application: await getMyCompanionApplicationDetail(user.id, searchParams, "http"),
    });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
