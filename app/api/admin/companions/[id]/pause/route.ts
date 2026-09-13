import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminCompanionFlags } from "@/lib/services/adminCompanions";

/**
 * 暂停接单：`POST /api/admin/companions/[id]/pause`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 「暂停」= 仍然是启用状态、公开展示照旧，但**结算页选不中**。
 * 与「停用」是两件事：停用会让资料从用户端列表与结算页一起消失。
 * 两者都从这里分开的接口走，因为它们的后果完全不同，合并成一个「改状态」接口
 * 会让调用方自己去拼目标状态，而拼错的结果是「只是歇两天」变成「这个人下架了」。
 *
 * 请求体：`{ idempotencyKey, unavailableReason }`。原因**必填**——
 * §八 要求不可接单必须有原因，否则用户端只会看到「暂不可接单」而不知道该等什么。
 *
 * ⚠️ 写入是**窄**的：只改启用 / 可接单 / 原因三个字段，不会顺带把昵称、介绍、
 * 排序写回去（见 `applyCompanionFlags()` 的说明）。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companions/[id]/pause">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminCompanionFlags(id, "pause", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
