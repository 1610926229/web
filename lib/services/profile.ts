import { ApiError } from "@/lib/api/ApiError";
import {
  AVATAR_INVALID_MESSAGE,
  AVATAR_REQUIRED_MESSAGE,
  isAllowedAvatar,
  normalizeBio,
  normalizeNickname,
} from "@/lib/constants/profile";
import { readTrimmedString } from "@/lib/constants/writes";
import { getUserRepository, type UserRecord } from "@/lib/data/userRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { UserProfile } from "@/lib/types/user";

/**
 * 用户资料服务 —— 「我的」页、编辑资料页、设置页与 `/api/me` 共用的唯一入口。
 *
 * 三条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只返回公开资料**。DTO 就是 `id / displayId / nickname / avatarUrl / bio` 五项，
 *    由 `toUserProfile()` **显式挑字段**拼出来，而不是把用户记录整体丢出去——
 *    将来记录上多出任何字段（微信标识、内部角色、风控标记）都不会顺势泄漏给客户端。
 * 2. **身份来自服务端会话**。这里的每个函数都要求调用方传入 `userId`，
 *    而这个值只能来自会话（见 `lib/api/route.ts` 的 `requireUser()`），
 *    请求体里的 `userId` / `id` 一概不读——改不了别人的资料。
 * 3. **资料读写只碰资料**。`displayId` 与 `id` 不受编辑影响：编辑资料不是修改微信身份数据。
 */

/** 资料 → 公开 DTO。**就这五个字段**，将来记录上新增字段不会顺势外泄。 */
export function toUserProfile(record: UserRecord): UserProfile {
  return {
    id: record.id,
    displayId: record.displayId,
    nickname: record.nickname,
    avatarUrl: record.avatarUrl,
    bio: record.bio,
  };
}

/**
 * 读取当前用户的公开资料。
 *
 * 会话有效但用户记录已不存在（例如数据被清理）时返回 null，
 * 由调用方决定是 404 还是提示重新登录——这里不编一份假资料出来。
 */
export async function getUserProfile(
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<UserProfile | null> {
  if (!userId) return null;

  const record = await withMockDebug(params, surface, () =>
    getUserRepository().findUserById(userId),
  );
  return record ? toUserProfile(record) : null;
}

/** 编辑资料表单的**白名单**解析结果。 */
export type ProfileInput = {
  nickname: string;
  avatarUrl: string;
  bio: string;
};

/**
 * 按白名单解析编辑资料表单。
 *
 * 只读三个字段：`displayId` / `id` / `userId` 之类即便塞进请求体也一律被忽略，
 * 因此伪造不出「改别人的资料」或「改自己的平台 ID」。
 *
 * `currentAvatarUrl` 用于放行「不换头像」的情况：头像必须来自白名单选项，
 * 或者就是该用户当前已经存着的那个地址（详见 `isAllowedAvatar`）。
 */
export function parseProfileInput(
  body: Record<string, unknown>,
  currentAvatarUrl: string,
): ProfileInput {
  const nickname = normalizeNickname(
    typeof body.nickname === "string" ? body.nickname : "",
  );
  if (!nickname.ok) throw new ApiError("BAD_REQUEST", nickname.message);

  const bio = normalizeBio(typeof body.bio === "string" ? body.bio : "");
  if (!bio.ok) throw new ApiError("BAD_REQUEST", bio.message);

  const avatarUrl = readTrimmedString(body, "avatarUrl");
  if (!avatarUrl) throw new ApiError("BAD_REQUEST", AVATAR_REQUIRED_MESSAGE);
  if (!isAllowedAvatar(avatarUrl, currentAvatarUrl)) {
    throw new ApiError("BAD_REQUEST", AVATAR_INVALID_MESSAGE);
  }

  return { nickname: nickname.nickname, avatarUrl, bio: bio.bio };
}

/**
 * 更新当前用户的资料，返回更新后的公开 DTO。
 *
 * 昵称与简介的规则（必填 / 长度 / 去首尾空格）在 `lib/constants/profile.ts`，
 * 页面与服务端共用同一份实现，因此前端提示与服务端校验不会出现两套说法。
 */
export async function updateUserProfile(
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<UserProfile> {
  const repository = getUserRepository();

  const current = await withMockDebug(params, surface, () => repository.findUserById(userId));
  if (!current) throw new ApiError("NOT_FOUND", "用户不存在");

  const input = parseProfileInput(body, current.avatarUrl);

  const updated = await repository.updateProfile(userId, input);
  if (!updated) throw new ApiError("NOT_FOUND", "用户不存在");

  return toUserProfile(updated);
}
