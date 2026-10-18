import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { completeMockWechatLogin } from "@/lib/services/mockWechatLogin";

/**
 * 完成一次 Mock 微信登录：`POST /api/auth/wechat/mock/complete`。
 *
 * 只在私有 Staging（`DATA_SOURCE=postgres` + `ENABLE_MOCK_AUTH=true`）可用；
 * 未启用时 404。请求体只有两个字段：`key`（模拟身份）与 `redirect`（站内回跳）。
 *
 * ⚠️ 不接受 `userId` / `openid` / `role` 等任何身份或角色字段：
 * 身份由服务端的模拟身份表决定，角色不会被本接口授予。
 *
 * 同一来源校验：带 `Origin` 头时必须与当前站点一致，避免跨站表单
 * 诱导浏览器发起 Mock 登录。公网请求另有 Nginx + `proxy.ts` 两层拒绝。
 */
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      const expectedHost =
        request.headers.get("x-forwarded-host") ?? request.headers.get("host");
      if (!originHost || (expectedHost && originHost !== expectedHost)) {
        throw new ApiError("FORBIDDEN", "请求来源无效", 403);
      }
    }

    const body = await readJsonBody(request);
    const result = await completeMockWechatLogin(body.key, body.redirect);
    return ok(result);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
