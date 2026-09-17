import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import {
  queryAdminAgreementList,
  resolveAdminAgreementListQuery,
} from "@/lib/services/adminAgreements";

/**
 * 管理端协议列表：`GET /api/admin/content/agreements`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。普通用户、客服、护航与停用管理员一律 401 / 403 ——
 * 权限判断只有 `lib/api/adminRoute.ts` 一处，服务层不再判一次。
 *
 * 返回**全部五项协议（含停用的那条）**：停用是可逆的，列表上看不见它就永远
 * 无法把它重新启用。用户端那一侧是另一条路径（`lib/services/agreements.ts`），
 * 只看得到启用项，两者读的是同一份数据。
 *
 * ⚠️ **没有 POST**：协议类型是固定枚举（用户 / 隐私 / 陪玩 / 平台 / 版本），
 * 每个类型有且只有一条记录，不存在「新建一份协议」这项能力。要下架一份协议是把它
 * **停用**，而不是删掉——前台五个页签永远都在。
 *
 * 列表行里**不带正文**（正文有几十段，只在详情里下发），
 * 但带 `sectionCount` / `paragraphCount` 两个标量，让运营一眼看出这份协议有多长。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = resolveAdminAgreementListQuery(searchParams);

    return ok(await queryAdminAgreementList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
