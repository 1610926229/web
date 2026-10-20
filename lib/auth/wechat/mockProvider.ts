import { MOCK_AVATAR_OPTIONS } from "@/lib/constants/profile";

/**
 * 私有 Staging 的 Mock 微信身份（**仅服务端与 Mock 页面使用**）。
 *
 * ## 它模拟的是什么
 *
 * 只模拟「微信返回了哪个 openid、昵称与头像」这一件事。登录成功后走的是与真实
 * 微信**完全相同**的身份解析与会话创建路径（`resolveOrCreateUserFromIdentity`
 * + `createRealSession`），不存在第二条「Mock 登录后门」。
 *
 * ## 与真实 provider 的隔离
 *
 * - provider 值是 `mock`，不是 `wechat`；
 * - app_id 是固定占位值，不是任何真实 AppID；
 * - openid 带 `mock-openid-` 前缀；
 * - 真实回调代码路径**不 import 本文件**。
 *
 * 因此 Mock 身份在数据库里永远不会被真实微信登录认成同一个人，
 * 真实微信账号也不会因为 openid 相撞而串号。
 *
 * ⚠️ 这些身份**不携带任何角色**。选择「护航小陈」不会让账号变成护航；
 * 打手资格只来自入驻审核（`companion_applications` → `companions.user_id`）。
 */

export const MOCK_WECHAT_APP_ID = "mock-wechat-staging";

export type MockWechatIdentity = {
  /** 页面选择与接口参数使用的稳定 key */
  key: string;
  nickname: string;
  avatarUrl: string;
  /** 页面上的说明：这个身份适合验证什么 */
  description: string;
};

export const MOCK_WECHAT_IDENTITIES: readonly MockWechatIdentity[] = [
  {
    key: "alpha",
    nickname: "微信用户·阿超",
    avatarUrl: MOCK_AVATAR_OPTIONS[0],
    description: "全新微信身份。首次选择会创建一个平台用户，再次选择会回到同一个用户。",
  },
  {
    key: "beta",
    nickname: "微信用户·小目",
    avatarUrl: MOCK_AVATAR_OPTIONS[1],
    description: "第二个独立身份，可用于验证两个微信账号看不到彼此的订单。",
  },
  {
    key: "gamma",
    nickname: "微信用户·小陈",
    avatarUrl: MOCK_AVATAR_OPTIONS[2],
    description: "用于验证打手绑定：普通微信身份仍需提交入驻申请并通过审核，才会获得工作台权限。",
  },
];

export function findMockWechatIdentity(key: unknown): MockWechatIdentity | null {
  if (typeof key !== "string") return null;
  return MOCK_WECHAT_IDENTITIES.find((identity) => identity.key === key) ?? null;
}

/** 该 Mock 身份对应的 openid。前缀保证与真实 openid 不会相同。 */
export function mockWechatOpenId(key: string): string {
  return `mock-openid-${key}`;
}
