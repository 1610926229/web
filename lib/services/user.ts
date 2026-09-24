import { apiPost } from "@/lib/api/client";
import type { User } from "@/lib/types/user";

/**
 * 认证相关服务。
 *
 * 当前对应 Mock 接口：写入/清除 Mock 会话 Cookie，不调用任何真实微信接口、
 * 不使用任何 AppID / AppSecret / 商户号 / 密钥。
 */

/**
 * 登录。
 *
 * 直接调用时以默认 Mock 用户登录；验收期需要切换用户时，
 * 可携带 `{ userId }`（见 README「Mock 认证」一节）。
 *
 * ⚠️ 这里是**客户端登录的唯一出口**（`authAdapter` 是它唯一的调用者）：
 * 登录界面（`LoginGate`）与 DEV-1 的身份切换面板（`MockIdentityPanel`）都走这条路，
 * 没有第二条自己拼请求的路径。
 */
export function login(userId?: string): Promise<User> {
  return apiPost<User>("/api/auth/mock-login", userId ? { userId } : {});
}

export function logout(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>("/api/auth/logout");
}
