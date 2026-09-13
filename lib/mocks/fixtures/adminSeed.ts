import type { AdminAccount } from "@/lib/types/admin";

/**
 * 管理端账号的预置数据（**Mock**）。
 *
 * ⚠️ 这里**没有密码、没有密钥、没有任何凭据**——本阶段的登录是一个固定的模拟入口，
 * 不给用户输入账号密码的地方，也就没有可以泄漏、可以撞库、可以提交进仓库的东西。
 * 真实管理员账号体系属于后续阶段。
 *
 * ⚠️ 这份数据与用户仓储（`userSeed`）**没有任何对应关系**：同一个字符串
 * 在这一份里是管理者、在那一份里不存在，反之亦然。两边不共享 id、不互相查询，
 * 因此「用户 Cookie 换管理权限」在数据层就没有可以走的路径。
 *
 * `admin-1` 是模拟登录唯一使用的账号。其余三条是**会被拒绝的身份**，
 * 它们存在的意义是让「客服不能进」「护航不能进」「停用的管理员不能进」这三条规则
 * 有真实数据可验证，而不是只写在注释里。
 */
export const adminSeed: readonly AdminAccount[] = [
  {
    id: "admin-1",
    username: "mock-admin",
    displayName: "模拟管理员（占位）",
    role: "admin",
    enabled: true,
    lastLoginAt: null,
  },
  {
    id: "admin-2",
    username: "mock-service",
    displayName: "模拟客服（占位）",
    role: "customer_service",
    enabled: true,
    lastLoginAt: null,
  },
  {
    id: "admin-3",
    username: "mock-companion",
    displayName: "模拟护航（占位）",
    role: "companion",
    enabled: true,
    lastLoginAt: null,
  },
  {
    id: "admin-4",
    username: "mock-admin-disabled",
    displayName: "已停用的模拟管理员（占位）",
    role: "admin",
    enabled: false,
    lastLoginAt: null,
  },
];

/**
 * 模拟登录唯一使用的账号 id。
 *
 * 单独导出一个常量而不是在接口里写 `adminSeed[0].id`：登录页只有**一个**固定的
 * 「模拟管理员登录」按钮，没有账号切换器，改动预置数据顺序不应该悄悄换掉登录身份。
 */
export const MOCK_ADMIN_LOGIN_ID = "admin-1";
