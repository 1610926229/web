import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminQuickEntryEnabled } from "@/lib/services/adminQuickEntries";

/**
 * 停用快捷入口：`POST /api/admin/content/quick-entries/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 停用的后果只有一层，而且是立刻生效的：这条入口**不再出现在用户端首页四宫格**
 * （`isContentVisible()` 判定为不可见，见 `lib/constants/homeContent.ts`）。
 * 它**不是移除**——记录还在、随时可以启用回来，后台默认列表里也仍然看得到它。
 *
 * 重复停用是幂等的：不写数据、不写第二条审计，返回 `changed: false`。
 *
 * ⚠️ 停用**不改地址**：一次「关掉格子」的操作不该顺手把目标地址写回旧值，
 * 那会让运营刚刚调整好的入口在启用回来时指向一个没人选过的位置。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/quick-entries/[id]/disable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminQuickEntryEnabled(id, false, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
