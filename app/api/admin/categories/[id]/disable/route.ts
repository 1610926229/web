import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminCategoryEnabled } from "@/lib/services/adminCategories";

/**
 * 停用类目：`POST /api/admin/categories/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 停用的后果有两层，都在服务端保证：
 * - 该类目**不进入用户端导航**（`isCategoryVisible()` 判定为不可见）；
 * - 它**不能再用于新建、编辑归属或上架商品**——这条校验在商品写操作的原子区段里，
 *   因此「刚停用、紧接着一个商品上架请求到达」这种并发不会被穿透。
 *
 * ⚠️ 停用**不下架它下面的商品**：那些商品仍然上架（直链可用），只是用户端已经没有
 * 入口能走到它们。一次点击静默下架一批还在卖的东西是不可接受的。
 *
 * 界面上的入口在类目详情页（列表是只读的，理由与护航名单一致：
 * 表格里放一排会改数据的按钮，等于把「改错了」的概率乘上每一行）。
 *
 * 重复停用是幂等的：不写数据、不写第二条审计，返回 `changed: false`。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/categories/[id]/disable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminCategoryEnabled(id, false, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
