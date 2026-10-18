/**
 * 三套身份的 Cookie 名（**唯一一份清单**）。
 *
 * 三类身份各有两个互不相通的 Cookie：
 *
 * | 身份 | 真实会话 | Mock 会话 |
 * |---|---|---|
 * | 用户 | `chaoge_user_session` | `mock_user_id` |
 * | 客服 | `chaoge_staff_session` | `mock_staff_id` |
 * | 管理员 | `chaoge_admin_session` | `mock_admin_id` |
 *
 * ⚠️ 真实会话 Cookie 里是**不透明令牌**（数据库只存它的 SHA-256），
 * Mock Cookie 里是账号 id 本身。两者名字不同、含义不同，**没有任何代码路径**
 * 会把其中一个当成另一个：读取函数按身份写死只读自己的那两个名字。
 *
 * ⚠️ 单独成文件是为了打断 `session.ts ↔ realSession.ts` 的循环依赖：
 * 创建真实会话时要顺手清掉同一身份的 Mock Cookie，「真实登录覆盖 Mock 登录」
 * 才是一个事实，而不是靠谁先被读到。
 */

export const MOCK_USER_SESSION_COOKIE = "mock_user_id";
export const MOCK_STAFF_SESSION_COOKIE = "mock_staff_id";
export const MOCK_ADMIN_SESSION_COOKIE = "mock_admin_id";

export const REAL_USER_SESSION_COOKIE = "chaoge_user_session";
export const REAL_STAFF_SESSION_COOKIE = "chaoge_staff_session";
export const REAL_ADMIN_SESSION_COOKIE = "chaoge_admin_session";
