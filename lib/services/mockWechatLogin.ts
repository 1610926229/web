import { ApiError } from "@/lib/api/ApiError";
import { createRealSession } from "@/lib/auth/realSession";
import { isMockWechatLoginEnabled } from "@/lib/auth/wechat/config";
import {
  MOCK_WECHAT_APP_ID,
  findMockWechatIdentity,
  mockWechatOpenId,
} from "@/lib/auth/wechat/mockProvider";
import { sanitizeRedirectPath } from "@/lib/auth/wechat/stateToken";
import { resolveOrCreateUserFromIdentity } from "@/lib/data/pg/wechatRepository";

/**
 * 私有 Staging 的**模拟微信登录**（仅服务端）。
 *
 * ## 与真实登录的关系
 *
 * 只有「身份从哪里来」不同：这里从固定名单里选，真实登录从微信开放平台换取。
 * 之后走**完全相同**的 `resolveOrCreateUserFromIdentity()` 与
 * `createRealSession("user", …)`，不存在第二条会话路径。
 *
 * ## 与真实回调的隔离
 *
 * - 真实回调（`app/api/auth/wechat/callback`）只 import `wechatLogin.ts`，
 *   而本文件反向不 import 真实 provider；
 * - provider 值 `mock`、固定 app_id 与 `mock-openid-` 前缀，保证 Mock 身份
 *   永远不会被真实微信登录认成同一个人；
 * - 本文件**不 import** 任何客服 / 管理员 / 打手仓储，也不授予任何角色。
 *
 * ## 开关
 *
 * 未启用时按「接口不存在」(404) 处理，而不是 403——不承认这个入口存在。
 */

export async function completeMockWechatLogin(
  keyRaw: unknown,
  redirectRaw: unknown,
): Promise<{ redirectTo: string }> {
  if (!isMockWechatLoginEnabled()) {
    throw new ApiError("NOT_FOUND", "模拟微信登录未启用", 404);
  }

  const identity = findMockWechatIdentity(keyRaw);
  if (!identity) {
    throw new ApiError("BAD_REQUEST", "模拟微信身份不存在");
  }

  const resolved = await resolveOrCreateUserFromIdentity({
    provider: "mock",
    appId: MOCK_WECHAT_APP_ID,
    openId: mockWechatOpenId(identity.key),
    unionId: null,
    nickname: identity.nickname,
    avatarUrl: identity.avatarUrl,
    at: new Date().toISOString(),
  });

  await createRealSession("user", resolved.userId);
  return { redirectTo: sanitizeRedirectPath(redirectRaw) };
}
