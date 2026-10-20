import { apiPost } from "@/lib/api/client";
import type { User } from "@/lib/types/user";

/**
 * 用户真实注册 / 登录的**浏览器端**调用。
 *
 * ⚠️ 只做「拼请求、发出去、按类型返回」。密码校验、邮箱规范化、哈希与会话
 * 全在服务端（`lib/services/realUserAuth.ts`），浏览器里没有任何一份副本。
 *
 * 成功响应里的 `User` 是会话 DTO（`id / nickname / avatarUrl`），
 * 不含邮箱、展示号或任何凭据字段。
 */

export function registerRealUser(input: {
  email: string;
  password: string;
  nickname?: string;
}): Promise<User> {
  return apiPost<User>("/api/auth/register", input);
}

export function loginRealUser(input: { email: string; password: string }): Promise<User> {
  return apiPost<User>("/api/auth/login", input);
}
