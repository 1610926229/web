import type { User } from "@/lib/types/user";

/**
 * 认证适配器契约 —— 页面只依赖这个接口，不依赖具体登录方式。
 *
 * 当前实现：`MockAuthAdapter`（写 Mock 会话 Cookie；不调用任何真实微信接口，
 * 不使用 AppID / AppSecret / 商户号 / 密钥 / 回调地址）。
 *
 * 未来实现：微信公众号网页授权。此时 `login()` 改为「跳转授权链接 → 用 code 换取
 * 服务端会话」，`logout()` 清除服务端会话；页面与守卫代码无需改动，
 * 只需替换 `MockAuthAdapter` 中导出的 `authAdapter` 一行。
 */
export type AuthAdapter = {
  login(): Promise<User>;
  logout(): Promise<void>;
};
