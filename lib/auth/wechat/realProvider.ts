import { NICKNAME_MAX_LENGTH } from "@/lib/constants/profile";
import { readRealWechatConfig, type RealWechatConfig } from "./config";
import { WechatLoginFlowError } from "./errors";

/**
 * 微信开放平台「网站应用扫码登录」适配器（**仅服务端**）。
 *
 * 文档：
 * - 授权页 `https://open.weixin.qq.com/connect/qrconnect`
 * - 换取令牌 `https://api.weixin.qq.com/sns/oauth2/access_token`
 * - 用户信息 `https://api.weixin.qq.com/sns/userinfo`
 *
 * ## 安全边界
 *
 * - AppSecret 只出现在**服务端** token 请求参数里；不写日志、不返回给调用方、
 *   不进入任何错误信息。本文件抛出的错误只带固定枚举 reason。
 * - access_token 只在本次请求内存里存在，换取 userinfo 后立即丢弃，不落库。
 * - 微信接口的错误响应可能包含 `errmsg`（中文描述）与 `errcode`；
 *   它们只用于**分类**，不原样透出到页面或日志。
 * - 所有请求都有 10 秒超时；断网、超时、非 JSON 响应都归为 `network`。
 *
 * ## 为什么 userinfo 失败也要拒绝登录
 *
 * token 里已有 openid，理论上可以先登录再补资料。但那样会出现「登录成功、
 * 昵称却是占位值」的半成品账号，而且用户信息接口失败往往意味着配置或权限
 * 有问题。这里选择失败并提示重试，让问题在登录这一步暴露。
 */

const AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect";
const TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";
const REQUEST_TIMEOUT_MS = 10_000;

export type WechatUserIdentity = {
  openId: string;
  unionId: string | null;
  nickname: string;
  avatarUrl: string;
};

type WechatErrorBody = {
  errcode?: number;
  errmsg?: string;
};

/** 构造扫码授权地址。state 原文只由调用方生成并同时写入 Cookie。 */
export function buildWechatAuthorizeUrl(state: string): string {
  const config = requireConfig();
  const params = new URLSearchParams({
    appid: config.appId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "snsapi_login",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}#wechat_redirect`;
}

function requireConfig(): RealWechatConfig {
  const config = readRealWechatConfig();
  if (!config) throw new WechatLoginFlowError("not-configured");
  return config;
}

/** 解析微信的 JSON 响应。微信历史上会以 `text/plain` 返回 JSON，因此不依赖 content-type。 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WechatLoginFlowError("network", "无法连接微信服务");
  }

  const body = await readJson(response);
  if (!body) {
    throw new WechatLoginFlowError("network", "微信服务返回了无法解析的响应");
  }
  return body;
}

function errcodeOf(body: Record<string, unknown>): number | null {
  const value = (body as WechatErrorBody).errcode;
  return typeof value === "number" && value !== 0 ? value : null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 昵称截断到平台规则的 15 个字符；空值回落到固定文案。 */
function normalizeWechatNickname(raw: unknown): string {
  const nickname = stringOf(raw);
  if (!nickname) return "微信用户";
  return Array.from(nickname).slice(0, NICKNAME_MAX_LENGTH).join("");
}

/**
 * 用授权码换用户身份。
 *
 * 失败分类：
 * - `code-invalid`：40029（code 非法）、40163（code 已被使用）、40226（账号受限）；
 * - `network`：请求失败 / 响应不可解析；
 * - `failed`：其他 errcode 或缺少 openid。
 */
export async function exchangeWechatCode(code: string): Promise<WechatUserIdentity> {
  const config = requireConfig();

  const tokenParams = new URLSearchParams({
    appid: config.appId,
    secret: config.appSecret,
    code,
    grant_type: "authorization_code",
  });
  const tokenBody = await getJson(`${TOKEN_URL}?${tokenParams.toString()}`);
  const tokenError = errcodeOf(tokenBody);
  if (tokenError !== null) {
    if (tokenError === 40029 || tokenError === 40163 || tokenError === 40226) {
      throw new WechatLoginFlowError("code-invalid", "授权码无效或已使用");
    }
    throw new WechatLoginFlowError("failed", "微信授权失败");
  }

  const accessToken = stringOf(tokenBody.access_token);
  const openId = stringOf(tokenBody.openid);
  if (!accessToken || !openId) {
    throw new WechatLoginFlowError("failed", "微信授权响应缺少必要字段");
  }

  const infoParams = new URLSearchParams({
    access_token: accessToken,
    openid: openId,
    lang: "zh_CN",
  });
  const infoBody = await getJson(`${USERINFO_URL}?${infoParams.toString()}`);
  if (errcodeOf(infoBody) !== null) {
    throw new WechatLoginFlowError("failed", "无法读取微信用户信息");
  }

  // userinfo 返回的 openid 必须与 token 一致；不一致说明响应被替换或串号
  const infoOpenId = stringOf(infoBody.openid);
  if (infoOpenId && infoOpenId !== openId) {
    throw new WechatLoginFlowError("failed", "微信身份不一致");
  }

  const unionId =
    stringOf(infoBody.unionid) || stringOf(tokenBody.unionid) || null;

  return {
    openId,
    unionId,
    nickname: normalizeWechatNickname(infoBody.nickname),
    avatarUrl: stringOf(infoBody.headimgurl).slice(0, 500),
  };
}
