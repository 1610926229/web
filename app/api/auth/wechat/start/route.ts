import { WechatLoginFlowError } from "@/lib/auth/wechat/errors";
import { errorPageUrl } from "@/lib/auth/wechat/redirect";
import { startRealWechatLogin } from "@/lib/services/wechatLogin";

/**
 * 发起真实微信扫码登录：`GET /api/auth/wechat/start?redirect=/orders`。
 *
 * - 配置齐全：生成一次性 state（数据库 + HttpOnly Cookie），302 到微信授权页；
 * - 未配置：302 到 `/wechat-login?error=not-configured`，页面明确说明未配置。
 *
 * ⚠️ 未配置时**绝不**降级到 Mock、绝不伪造登录。Mock 只有一个独立入口
 * `/wechat-mock`，由用户主动选择。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  try {
    const authorizeUrl = await startRealWechatLogin(url.searchParams.get("redirect"));
    return Response.redirect(authorizeUrl, 302);
  } catch (cause) {
    const reason = cause instanceof WechatLoginFlowError ? cause.reason : "failed";
    return Response.redirect(errorPageUrl(request, reason), 302);
  }
}
