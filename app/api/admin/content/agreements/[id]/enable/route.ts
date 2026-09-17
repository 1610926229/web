import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminAgreementEnabled } from "@/lib/services/adminAgreements";

/**
 * 启用协议：`POST /api/admin/content/agreements/[id]/enable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 走的是**窄写入**（只改 `enabled` 一个字段），不是把整条记录写回去：
 * 界面上开关如果走「先读出来、拼一个完整 patch 再保存」，两位管理员同时操作时，
 * 后写的那次会把另一位刚改好的**正文**覆盖回旧值——协议正文是几十段文本，
 * 那种覆盖是发现不了的。
 *
 * ⚠️ **不动版本号**：启用状态不是正文的版本。「停用再启用」不该让用户端
 * 看到一个从未存在过的新版本。
 *
 * 重复启用是**幂等**的：已经启用的协议再启用一次不写数据、不写第二条审计、
 * 不刷新更新时间，返回 `changed: false`。真正的防重是幂等键加服务端的状态判断（§九），
 * 不是按钮禁用。
 *
 * 请求体只需要 `idempotencyKey`：这条路径没有任何业务字段可填。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/agreements/[id]/enable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminAgreementEnabled(admin.id, id, true, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
