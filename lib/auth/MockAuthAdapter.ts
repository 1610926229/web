import type { AuthAdapter } from "./AuthAdapter";
import { login, logout } from "@/lib/services/user";

/**
 * 当前启用的认证实现。
 *
 * 接入真实微信网页授权时，只替换这一处的赋值，页面与守卫逻辑不变。
 */
export const authAdapter: AuthAdapter = {
  // Mock 实现**会**读 userId（登录界面上的测试账号名单），真实实现不会
  login: (userId) => login(userId),
  logout: () => logout().then(() => undefined),
};
