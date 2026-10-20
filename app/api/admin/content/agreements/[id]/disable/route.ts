import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminAgreementEnabled } from "@/lib/services/adminAgreements";

/**
 * 停用协议：`POST /api/admin/content/agreements/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 停用是协议**唯一的下架方式**：本阶段没有「删除协议」这项能力（类型是固定枚举，
 * 每个类型有且只有一条记录，前台五个页签永远都在），因此停用必须是可逆的——
 * 用户端那一栏会显示「内容暂未配置」，其余页签不受影响，重新启用即恢复。
 *
 * 与启用同一条窄写入路径：只改 `enabled` 一个字段，**不动版本号**，
 * 也不碰标题与正文（理由见 `../enable/route.ts`）。
 *
 * 重复停用是**幂等**的：不写数据、不写第二条审计、不刷新更新时间，
 * 返回 `changed: false`。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/agreements/[id]/disable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminAgreementEnabled(admin.id, id, false, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
