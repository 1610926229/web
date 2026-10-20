import { randomUUID } from "node:crypto";
import { createRealSession, isRealAuthEnabled } from "@/lib/auth/realSession";
import {
  isMockWechatLoginEnabled,
  isRealWechatLoginConfigured,
  readRealWechatConfig,
} from "@/lib/auth/wechat/config";
import { WechatLoginFlowError } from "@/lib/auth/wechat/errors";
import {
  buildWechatAuthorizeUrl,
  exchangeWechatCode,
} from "@/lib/auth/wechat/realProvider";
import {
  WECHAT_STATE_TTL_SECONDS,
  clearWechatStateCookie,
  createWechatStateToken,
  hashWechatState,
  isPlausibleWechatState,
  readWechatStateCookie,
  sanitizeRedirectPath,
  setWechatStateCookie,
  statesMatch,
} from "@/lib/auth/wechat/state";
import {
  consumeOAuthState,
  createOAuthState,
  resolveOrCreateUserFromIdentity,
  wasOAuthStateExpired,
} from "@/lib/data/pg/wechatRepository";

/**
 * 微信网页登录的**服务端流程**（仅服务端）。
 *
 * ## 两种 provider，一条会话路径
 *
 * Mock 与真实微信的差别只在「身份从哪里来」：
 * - 真实：微信开放平台扫码 → code → 服务端换取 openid/userinfo；
 * - Mock：私有 Staging 页面选择一个模拟身份。
 *
 * 身份解析之后的步骤完全相同：`resolveOrCreateUserFromIdentity()` →
 * `createRealSession("user", userId)`。因此两种登录在数据库里的会话记录、
 * Cookie、过期时间、权限边界**没有任何区别**，区别只体现在
 * `external_identities.provider` 与页面文案上。
 *
 * ## 不产生角色
 *
 * 本文件不 import 任何客服 / 管理员 / 打手仓储，也不写 `user_qualifications`。
 * 微信能证明的只有「你是哪个用户」，不能把用户变成客服、管理员或护航。
 */

export type WechatLoginStatus = {
  /** 真实微信扫码是否可用（配置齐全且会话基础设施可用） */
  realConfigured: boolean;
  /** 私有 Staging 的模拟微信登录是否可用 */
  mockAvailable: boolean;
};

export function getWechatLoginStatus(): WechatLoginStatus {
  return {
    realConfigured: isRealAuthEnabled() && isRealWechatLoginConfigured(),
    mockAvailable: isMockWechatLoginEnabled(),
  };
}

/** 发起真实微信扫码：创建 state、写 Cookie、返回授权页地址。 */
export async function startRealWechatLogin(redirectRaw: unknown): Promise<string> {
  if (!isRealAuthEnabled() || !isRealWechatLoginConfigured()) {
    throw new WechatLoginFlowError("not-configured");
  }

  const state = createWechatStateToken();
  const now = new Date();
  const redirectTo = sanitizeRedirectPath(redirectRaw);

  await createOAuthState({
    id: `st_${randomUUID()}`,
    provider: "wechat",
    stateHash: state.hash,
    redirectTo,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + WECHAT_STATE_TTL_SECONDS * 1000).toISOString(),
  });
  await setWechatStateCookie(state.raw);

  return buildWechatAuthorizeUrl(state.raw);
}

/**
 * 校验并消费 state。
 *
 * 三道闸门缺一不可：
 * 1. query state 形状正确；
 * 2. 与发起登录的 HttpOnly Cookie 相同（防登录 CSRF）；
 * 3. 数据库中未消费、未过期（防重放/重试）。
 */
async function consumeStateOrThrow(stateRaw: unknown): Promise<string> {
  if (!isPlausibleWechatState(stateRaw)) {
    throw new WechatLoginFlowError("state-invalid");
  }

  const cookieState = await readWechatStateCookie();
  if (!cookieState || !statesMatch(cookieState, stateRaw)) {
    throw new WechatLoginFlowError("state-invalid");
  }

  const now = new Date();
  const stateHash = hashWechatState(stateRaw);
  const consumed = await consumeOAuthState(stateHash, now.toISOString());

  if (!consumed) {
    if (await wasOAuthStateExpired(stateHash, now.toISOString())) {
      throw new WechatLoginFlowError("state-expired");
    }
    throw new WechatLoginFlowError("state-invalid");
  }

  return sanitizeRedirectPath(consumed.redirectTo);
}

/**
 * 处理微信回调：消费 state → 用 code 换身份 → 建用户会话。
 *
 * 返回登录完成后应跳转的站内路径。任何失败都抛 `WechatLoginFlowError`，
 * 由路由统一跳转到 `/wechat-login?error=<reason>`。
 *
 * ⚠️ 无论成功失败都清除 state Cookie。
 */
export async function completeRealWechatLogin(
  codeRaw: unknown,
  stateRaw: unknown,
): Promise<string> {
  if (!isRealAuthEnabled() || !isRealWechatLoginConfigured()) {
    throw new WechatLoginFlowError("not-configured");
  }

  try {
    const redirectTo = await consumeStateOrThrow(stateRaw);

    const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
    if (!code) {
      // 微信只在「用户拒绝授权」等少数场景下不带 code 回调
      throw new WechatLoginFlowError("cancelled");
    }

    const identity = await exchangeWechatCode(code);
    const config = readRealWechatConfig();
    if (!config) throw new WechatLoginFlowError("not-configured");

    const resolved = await resolveOrCreateUserFromIdentity({
      provider: "wechat",
      appId: config.appId,
      openId: identity.openId,
      unionId: identity.unionId,
      nickname: identity.nickname,
      avatarUrl: identity.avatarUrl,
      at: new Date().toISOString(),
    });

    await createRealSession("user", resolved.userId);
    return redirectTo;
  } finally {
    await clearWechatStateCookie();
  }
}
