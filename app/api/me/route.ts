import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { getUserProfile, updateUserProfile } from "@/lib/services/profile";

/**
 * 当前用户资料接口（浏览器端调用）。
 *
 * 权限：必须登录。**接口不接受任何用户标识参数**——「查谁 / 改谁」只能由服务端会话决定，
 * 因此改请求体里的 `userId` / `id` 都改不到别人的资料。
 *
 * 返回的 DTO 固定为 `id / displayId / nickname / avatarUrl / bio` 五项，
 * 不含 openid、unionid、会话凭据与任何内部角色字段（见 `lib/services/profile.ts`）。
 * 昵称、简介、头像都不出现在 URL 上：读取不带参数，写入走请求体。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    const profile = await getUserProfile(user.id, searchParams, "http");
    // 会话有效但资料已被清理：如实返回 404，不编一份假资料
    if (!profile) throw new ApiError("NOT_FOUND", "用户不存在");

    return ok(profile);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

/**
 * 更新当前用户资料（昵称 / 头像 / 简介）。
 *
 * 三个字段一起提交（不做部分更新）：只改其中两个会让第三个悄悄变成空值。
 * 校验规则与编辑资料页共用 `lib/constants/profile.ts` 的同一份实现，
 * 前端拦住的与服务端拒绝的是同一批输入。
 */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await updateUserProfile(user.id, body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
