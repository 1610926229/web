import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { searchGrantTargetUsers } from "@/lib/services/adminCoupons";

/**
 * 管理端发券的目标用户搜索：`GET /api/admin/coupons/grant-targets?keyword=`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 关键词匹配 `id` / `displayId` / 昵称三处，返回条数有上限（见服务层）。
 * **空关键词返回空列表**，不是全部用户——「不带筛选地拉全量用户」不该是一个顺手可得的操作。
 *
 * ⚠️ 它与用户端「我的」页是**两个出口**：那边返回的是登录用户自己的资料，
 * 这边是管理员为**发券**而查人，因此只给 id / displayId / 昵称 / 头像
 * 与「他已经持有几张券」。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);

    return ok(await searchGrantTargetUsers(searchParams.get("keyword") ?? "", searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
