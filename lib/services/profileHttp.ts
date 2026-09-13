import { apiGet, apiPatch } from "@/lib/api/client";
import type { UserProfile } from "@/lib/types/user";

/**
 * 用户资料的**浏览器端**存取（编辑资料页）。
 *
 * 与服务端模块 `lib/services/profile.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 *
 * 「我的」页与设置页的资料由 Server Component 直接取，不经过本文件；
 * 因此这里只有编辑资料真正需要的两个调用。
 */

export function fetchMyProfile(): Promise<UserProfile> {
  return apiGet<UserProfile>("/api/me");
}

/** 只提交三个可编辑字段：昵称、头像、简介。身份字段（id / displayId）不参与写入。 */
export function updateMyProfile(input: {
  nickname: string;
  avatarUrl: string;
  bio: string;
}): Promise<UserProfile> {
  return apiPatch<UserProfile>("/api/me", input);
}
