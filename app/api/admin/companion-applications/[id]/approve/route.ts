import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { approveAdminApplication } from "@/lib/services/adminCompanionApplications";

/**
 * 审核通过：`POST /api/admin/companion-applications/[id]/approve`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 这是整个 P8A 里语义最重的一个接口。一次调用会产生**四笔写入**，
 * 且全部落在同一段没有 `await` 的同步区段里（`lib/data/adminCompanionTransaction.ts`）：
 * 1. 申请状态 → `approved`（并记录审核时间）；
 * 2. 该用户获得「护航」资格；
 * 3. 建立或复用唯一的那条护航资料；
 * 4. 写一条审计记录。
 *
 * 因此不存在「通过了但护航没建出来」的中间态：要么四笔都在，要么一笔都没有。
 * 重复请求（同一个幂等键）返回第一次的结果，**不会**建出第二条护航；
 * 同一用户已有有效护航时复用那一条，不会新建。
 *
 * ⚠️ 它**不改动 `UserRecord`**：这个人的老板身份、消费记录、订单、收藏一样不少，
 * 通过审核只是多了一个身份，不是换了一个人。
 *
 * 请求体只需要幂等键。审核人是谁取自服务端会话，接受客户端传「审核人」等于允许伪造审核记录。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companion-applications/[id]/approve">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await approveAdminApplication(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
