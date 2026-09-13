import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { createCompanionApplicationForUser } from "@/lib/services/companionApplications";

/**
 * 提交护航入驻申请。
 *
 * 权限：必须登录。申请人身份只来自服务端会话，接口不接受任何「替谁提交」参数。
 *
 * 四件事由服务端保证：
 * - **身份、单号、状态与时间用户写不了**：新申请只会是「待查看」，
 *   单号与提交时间由服务端生成，审核时间与审核备注留空；
 * - **一个人最多一条**：同一个幂等键重复提交返回第一次的结果，
 *   换一个键再提交会被「已有申请」规则挡住（并发请求同样只会留下一条）；
 * - **不改动任何业务数据**：本接口只写申请记录，不碰订单、支付、用户角色，
 *   也不创建陪玩公开资料；
 * - **没有审核入口**：本文件只有 POST，没有任何把状态改成
 *   `reviewing` / `approved` / `rejected` 的路径。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await createCompanionApplicationForUser(user.id, body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
