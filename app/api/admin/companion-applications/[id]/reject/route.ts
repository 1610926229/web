import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { rejectAdminApplication } from "@/lib/services/adminCompanionApplications";

/**
 * 审核拒绝：`POST /api/admin/companion-applications/[id]/reject`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 与通过的分界很清楚：拒绝**只改状态并留下审核意见**，不建护航、不发资格、不写第二张表。
 * 申请人是要看到这段意见的，所以它不允许为空——规则在
 * `normalizeAdminReviewNote()` 一处，超长与空串都在那里被挡住。
 *
 * 请求体：`{ idempotencyKey, reviewNote }`。
 * 审核人与审核时间都来自服务端，客户端传了也不读（§十二：伪造的审核人 / 状态 / 时间字段必须被忽略）。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companion-applications/[id]/reject">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await rejectAdminApplication(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
