import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminProductStatus } from "@/lib/services/adminProducts";

/**
 * 上架商品：`POST /api/admin/products/[id]/publish`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 走的是**窄写入**（只改 `status`），不是把整条商品写回去：列表上的上下架按钮
 * 如果走「读出来、拼一个完整 patch 再保存」，会把另一位管理员刚改好的价格覆盖回旧值。
 *
 * 上架是唯一有前置条件的写操作，两条都在**原子区段**里判定：
 * - 所属类目存在、属于同一游戏、已启用且未移除；
 * - 至少有一个**有效规格**（启用且未移除）——没有规格的商品挂上去，用户点进去
 *   看到的是一个无法下单的页面。
 *
 * 重复上架是**幂等**的：已经上架的商品再上架一次不写数据、不写第二条审计，
 * 返回 `changed: false`。真正的防重是幂等键加服务端的状态判断（§九），不是按钮禁用。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[id]/publish">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminProductStatus(id, "on", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
