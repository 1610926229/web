/**
 * 用户（老板）相关类型。
 *
 * 两个类型各司其职，刻意不合并：
 *
 * - `User` 是**登录态**里的身份：只回答「谁登录了」，会话 Cookie、AuthProvider、
 *   `requireUser()` 都用它。字段越少越好，登录链路不该顺带携带资料页才需要的字段。
 * - `UserProfile` 是**公开资料 DTO**：我的页、编辑资料页、`/api/me` 用它。
 *
 * 两者都**不含** openid / unionid / 会话凭据 / 内部角色权限：最终由微信公众号网页授权
 * 标识用户，openid 只在服务端保存，下发给浏览器的只有不可反推的会话凭证。
 */
export type User = {
  id: string;
  nickname: string;
  avatarUrl: string;
};

/**
 * 用户公开资料（用户端可见的全部字段，**就这五个**）。
 *
 * `displayId` 是平台给用户看的 ID（原型「ID: xxxx」那一行），
 * **不是** 微信 OpenID / UnionID，也不能由它反推出任何微信身份。
 */
export type UserProfile = {
  id: string;
  displayId: string;
  nickname: string;
  avatarUrl: string;
  bio: string;
};

/**
 * 管理端看到的用户摘要（**就这三个字段**）。
 *
 * 管理端要回答的是「这笔订单 / 这条退款 / 这条投诉是谁的」，因此需要平台内的用户标识、
 * 昵称，以及用户自己也能看到的 `displayId`（客服页面报单号时用它对人）。
 *
 * ⚠️ 与 `UserProfile` 分开而不是复用它：头像与简介是**用户端展示用**的字段，
 * 管理后台的列表与详情都用不到；将来资料页新增字段时，也不会自动跟着流进管理接口。
 * 这正是「显式挑字段」的做法——只有写在这里的字段才会被后台看到。
 *
 * ⚠️ 刻意**不含** openid / unionid / 会话凭证 / 手机号：管理端的身份不等于微信身份，
 * 后台也没有任何需要靠微信标识来认人的场景。
 */
export type AdminUserSummary = {
  id: string;
  nickname: string;
  displayId: string;
};
