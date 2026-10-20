import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminQuickEntryEnabled } from "@/lib/services/adminQuickEntries";

/**
 * 启用快捷入口：`POST /api/admin/content/quick-entries/[id]/enable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 走的是**窄写入**（只改 `enabled` 一个字段），不是把整条记录写回去：
 * 界面上的开关如果走「先读出来、拼一个完整 patch 再保存」，两位管理员同时操作时，
 * 后写的那次会把另一位刚改好的名称或目标地址覆盖回旧值。
 *
 * 重复启用是**幂等**的：已经启用的入口再启用一次不写数据、不写第二条审计，
 * 返回 `changed: false`。真正的防重是幂等键加服务端的状态判断（§九），
 * 不是按钮禁用。
 *
 * ⚠️ 本接口**不校验也不改写目标地址**：启停与地址是两件事，
 * 把地址一起写回去就等于让一个开关顺带修改了运营刚调好的配置。
 * 地址的安全由写入它的那条路径（新建 / 编辑）负责。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/quick-entries/[id]/enable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminQuickEntryEnabled(id, true, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
