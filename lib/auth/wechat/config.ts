import { isMockAuthEnabled } from "@/lib/config/env";
import { isPostgresDataSourceEnabled } from "@/lib/data/pg/config";

/**
 * 微信网页登录的环境配置（**仅服务端**）。
 *
 * ## 真实配置三项必须齐全
 *
 * | 变量 | 用途 |
 * |---|---|
 * | `WECHAT_APP_ID` | 开放平台网站应用 AppID（公开标识） |
 * | `WECHAT_APP_SECRET` | AppSecret（只用于服务端换取令牌，**永不**下发） |
 * | `WECHAT_REDIRECT_URI` | 回调地址，必须与微信开放平台登记的回调域名一致 |
 *
 * 缺任何一项都视为「未配置」：登录按钮显示明确提示，start 接口也不会
 * 用一个半成品配置去调微信。**绝不**用 Mock 或伪造成功来填空缺。
 *
 * ## Mock 开关
 *
 * Mock 微信登录复用既有的 `ENABLE_MOCK_AUTH`，并额外要求 PostgreSQL 数据源：
 * 它要写 `external_identities` 与 `users`，Mock 数据源下没有这些表。
 * 这样 Staging 不需要修改 root 管理的 `staging.env`。
 *
 * ⚠️ 用**动态 key** 访问 `process.env`：打包器会把静态写法在构建期内联成常量，
 * 「构建时没配、运行时配了」的差异会被悄悄抹掉。与 `lib/config/env.ts` 同一约定。
 */

export type RealWechatConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

export const WECHAT_NOT_CONFIGURED_MESSAGE =
  "微信登录尚未配置。需要微信开放平台网站应用 AppID、AppSecret 与已登记的回调地址。";

function readEnv(name: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : "";
}

/**
 * 读取真实微信配置；三项不齐或回调地址不是 http(s) URL 时返回 null。
 *
 * ⚠️ 返回值含 AppSecret。调用方只能把它用在服务端请求里，
 * 不得写日志、不得放进响应、不得进入任何 DTO。
 */
export function readRealWechatConfig(): RealWechatConfig | null {
  const appId = readEnv("WECHAT_APP_ID");
  const appSecret = readEnv("WECHAT_APP_SECRET");
  const redirectUri = readEnv("WECHAT_REDIRECT_URI");

  if (!appId || !appSecret || !redirectUri) return null;

  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }

  return { appId, appSecret, redirectUri };
}

/** 真实微信登录是否已配置。**只返回布尔值**，不泄露 AppID / Secret。 */
export function isRealWechatLoginConfigured(): boolean {
  return readRealWechatConfig() !== null;
}

/**
 * Mock 微信登录是否可用。
 *
 * 两个条件缺一不可：
 * 1. PostgreSQL 数据源（身份表与用户表都在库里）；
 * 2. `ENABLE_MOCK_AUTH=true`（沿用既有的私有开发开关）。
 *
 * 公网请求即使能到达这个函数，也会被 Nginx + `proxy.ts` 的双层白名单
 * 挡在 `/api/**` 之前；这里的开关是第三层。
 */
export function isMockWechatLoginEnabled(): boolean {
  return isPostgresDataSourceEnabled() && isMockAuthEnabled();
}
