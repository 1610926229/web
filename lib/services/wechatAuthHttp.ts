import { apiGet, apiPost } from "@/lib/api/client";

/**
 * 微信登录的**浏览器端**调用。
 *
 * 与 `realAuthHttp.ts` 同一原则：只拼请求、发出去、按类型返回。
 * code 交换、AppSecret、state 校验、身份解析与会话写入全部在服务端。
 *
 * 真实扫码登录不使用 fetch：它是一个浏览器整页跳转
 * （`/api/auth/wechat/start` → 微信授权页 → 回调），因此只需一个普通链接。
 */

export type WechatLoginStatus = {
  realConfigured: boolean;
  mockAvailable: boolean;
};

export function getWechatLoginStatus(): Promise<WechatLoginStatus> {
  return apiGet<WechatLoginStatus>("/api/auth/wechat/status");
}

export function completeMockWechatLogin(input: {
  key: string;
  redirect: string;
}): Promise<{ redirectTo: string }> {
  return apiPost<{ redirectTo: string }>("/api/auth/wechat/mock/complete", input);
}
