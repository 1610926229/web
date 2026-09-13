import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { startReviewAdminApplication } from "@/lib/services/adminCompanionApplications";

/**
 * 开始审核：`POST /api/admin/companion-applications/[id]/start-review`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 这个动作用途唯一：把 `pending` 改成 `reviewing`（「有人开始看了」）。
 * **它不通过、不建护航、不发资格**——通过有它自己的接口，因为那是四笔一起写的伪事务，
 * 与这里「只改一个状态」完全不是一件事。把两者合成一个「审核」接口，
 * 就会出现「点错按钮直接把申请通过了」这种无法撤销的后果。
 *
 * 请求体只需要幂等键（`idempotencyKey`）：改什么由路径决定，改成什么由服务端决定。
 * **不能依赖按钮禁用防重**——按钮挡不住网络重试，真正的防重在伪事务里按幂等键重放。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companion-applications/[id]/start-review">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await startReviewAdminApplication(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
