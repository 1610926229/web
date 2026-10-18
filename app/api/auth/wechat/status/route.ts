import { ok, toApiError, fail } from "@/lib/api/route";
import { getWechatLoginStatus } from "@/lib/services/wechatLogin";

/**
 * 微信登录可用性：`GET /api/auth/wechat/status`。
 *
 * 只返回两个布尔值：
 * - `realConfigured`：真实微信扫码是否已配置；
 * - `mockAvailable`：私有 Staging 的模拟登录是否可用。
 *
 * ⚠️ **不返回 AppID、AppSecret、回调地址或任何环境变量原文。**
 * 登录控件据此决定显示「微信扫码登录」「模拟微信登录（Staging）」还是
 * 「微信登录尚未配置」——三种状态必须能被用户看见，不能把未配置伪装成可用。
 *
 * 公网请求在到达本文件之前已被 Nginx 白名单与 `proxy.ts` 拒绝（`/api/**`）。
 */
export async function GET() {
  try {
    const response = ok(getWechatLoginStatus());
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
