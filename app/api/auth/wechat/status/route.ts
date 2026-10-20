import { ok, toApiError, fail } from "@/lib/api/route";
import { isPublicPreviewRequest } from "@/lib/auth/publicPreviewRequest";
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
 * ## 公网请求永远看不到 Mock
 *
 * Mock 微信登录只存在于私有 Staging。公网请求即使命中同一个进程，也强制
 * `mockAvailable: false`；真实配置与否照实返回。真正的 Mock 回调路径在
 * `proxy.ts` 与 Nginx 两层都被拒绝，这里只是不展示入口。
 */
export async function GET() {
  try {
    const status = getWechatLoginStatus();
    const publicRequest = await isPublicPreviewRequest();

    const response = ok({
      ...status,
      mockAvailable: publicRequest ? false : status.mockAvailable,
    });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
