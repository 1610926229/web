import { headers } from "next/headers";
import { ApiError } from "@/lib/api/ApiError";
import { isPublicAccessRequest, publicClientIp } from "@/lib/config/publicAccess";
import {
  checkLoginRateLimit,
  clearLoginIdentityFailures,
  noteLoginFailure,
  type LoginRateLimitScope,
} from "./loginRateLimit";

/**
 * 公网登录接口的限流接入（PROD-6 D5）。
 *
 * 只在**公网请求**上启用：Nginx 注入标记头后，登录路由先查失败额度再校验密码；
 * 私有 SSH 隧道与本地测试不受影响（Staging 的自动化用例会反复提交错误口令，
 * 不应被自己的限流挡住）。
 *
 * 用法：
 *
 *     const guard = await beginPublicLogin("staff", username);
 *     const staff = await loginStaffWithPassword(...);
 *     guard.succeeded();
 *
 * 失败路径必须调 `guard.failed(error)` —— 只放 `catch` 里，别在成功路径上误记。
 */

export const PUBLIC_LOGIN_RATE_LIMITED_MESSAGE = "登录尝试过于频繁，请稍后再试";

export type PublicLoginGuard = {
  /** 本次请求是否带公网标记头。 */
  publicRequest: boolean;
  /** 登录成功：清掉该登录名的失败计数。 */
  succeeded: () => void;
  /** 登录失败：仅 401（凭据错误）计入失败额度。 */
  failed: (cause: unknown) => void;
};

const NOOP_GUARD: PublicLoginGuard = {
  publicRequest: false,
  succeeded: () => {},
  failed: () => {},
};

export async function beginPublicLogin(
  scope: LoginRateLimitScope,
  username: string,
): Promise<PublicLoginGuard> {
  const requestHeaders = await headers();
  if (!isPublicAccessRequest(requestHeaders)) return NOOP_GUARD;

  const ip = publicClientIp(requestHeaders);
  const decision = checkLoginRateLimit(scope, ip, username);

  if (!decision.allowed) {
    throw new ApiError(
      "TOO_MANY_REQUESTS",
      PUBLIC_LOGIN_RATE_LIMITED_MESSAGE,
      429,
      decision.retryAfterSeconds,
    );
  }

  return {
    publicRequest: true,
    succeeded: () => clearLoginIdentityFailures(scope, username),
    failed: (cause) => {
      if (cause instanceof ApiError && cause.code === "UNAUTHORIZED") {
        noteLoginFailure(scope, ip, username);
      }
    },
  };
}
