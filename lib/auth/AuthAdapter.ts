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
  /**
   * 登录。
   *
   * ⚠️ `userId` 是**给 Mock 实现用的**：开发阶段手工验收要同时扮演老板与打手，
   * 登录界面因此提供一份测试账号名单（`lib/auth/MockUserPicker.tsx`）。
   *
   * **真实微信授权实现会忽略这个参数**——那时的身份由微信返回的 code 换取的会话决定，
   * 不由调用方声明。参数留在契约上而不是塞进 Mock 的私有分支，是为了让
   * 「登录」在全仓仍然只有一个签名、一个调用点；代价是这一句说明必须一直留着。
   */
  login(userId?: string): Promise<User>;
  logout(): Promise<void>;
};
