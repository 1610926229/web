/**
 * 用户（老板）相关类型。
 *
 * 最终由微信公众号网页授权标识用户；当前为 Mock 用户，不含 openid 等任何真实微信标识。
 */
export type User = {
  id: string;
  nickname: string;
  avatarUrl: string;
};
