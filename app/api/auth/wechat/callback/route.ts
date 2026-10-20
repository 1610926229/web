import { WechatLoginFlowError } from "@/lib/auth/wechat/errors";
import { errorPageUrl, requestUrl } from "@/lib/auth/wechat/redirect";
import { completeRealWechatLogin } from "@/lib/services/wechatLogin";

/**
 * 微信授权回调：`GET /api/auth/wechat/callback?code=…&state=…`。
 *
 * 流程全部在服务端完成：
 * 1. state 与 HttpOnly Cookie、数据库记录三方校验并一次性消费；
 * 2. code 换 access_token / openid / unionid / 用户信息（AppSecret 只在服务端）；
 * 3. 按 `(provider, app_id, openid)` 找用户，首次登录创建用户与外部身份；
 * 4. 调用既有的 `createRealSession("user", userId)` 写 `chaoge_user_session`；
 * 5. 302 回发起登录时的站内地址。
 *
 * 任何失败都跳转 `/wechat-login?error=<reason>`。**错误详情、code、token、
 * AppSecret 一律不出现在 URL、页面或日志里。**
 *
 * ⚠️ 本路径不 import Mock provider，也没有任何「真实失败后改用 Mock」的分支。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  try {
    const redirectTo = await completeRealWechatLogin(
      url.searchParams.get("code"),
      url.searchParams.get("state"),
    );
    return Response.redirect(requestUrl(request, redirectTo), 302);
  } catch (cause) {
    const reason = cause instanceof WechatLoginFlowError ? cause.reason : "failed";
    return Response.redirect(errorPageUrl(request, reason), 302);
  }
}
