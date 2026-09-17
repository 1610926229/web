import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  getAdminPlatformConfig,
  updateAdminPlatformConfig,
} from "@/lib/services/adminPlatformConfig";

/**
 * 管理端平台参数：`GET` / `PATCH /api/admin/platform-config`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。普通用户、客服、护航与停用管理员
 * 一律 401 / 403 —— 权限判断只有 `lib/api/adminRoute.ts` 一处，
 * 服务层不再判一次。
 *
 * ## 为什么只有一个地址，且没有 `[id]`
 *
 * 平台参数是**单例**：全局只有这一份配置，没有「列表」也没有「详情」。
 * 开一个 `/platform-config/[id]` 等于用路由结构宣称「参数可以有多条」，
 * 而那份声明会立刻被别处抄走。测试里的地址清单锁定了这一点。
 *
 * 同样**没有**「启用 / 停用」地址：参数只有取值，没有上架下架。
 *
 * ## PATCH 而不是 PUT
 *
 * 请求体只带要改的字段，不是整份配置的替换。本阶段只有一个字段，
 * 两者看起来一样；但下一项参数（例如接单并发上限）进来时，
 * PUT 的语义会要求调用方把**没打算改的字段**也一起送上来——
 * 那意味着「保存超时设置」这个动作会顺带重写并发上限，
 * 而重写用的是页面渲染时的旧值。
 *
 * ⚠️ PATCH 的入参是**白名单**：请求体里除 `publicPoolTimeoutMinutes` 与幂等键以外的
 * 键一律被忽略（服务层只读它认识的那两个），因此客户端**无法**借此改
 * `updatedAt` / `updatedByAdminId`。
 */
export async function GET() {
  try {
    await requireAdmin();

    return ok(await getAdminPlatformConfig());
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await updateAdminPlatformConfig(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
