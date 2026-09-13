import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_FORBIDDEN_MESSAGE,
  ADMIN_MOCK_LOGIN_DISABLED_MESSAGE,
  adminRoleLabel,
  canEnterAdminConsole,
} from "@/lib/constants/admin";
import { clearSessionAdmin, getSessionAdmin, setSessionAdmin } from "@/lib/auth/adminSession";
import { isMockAdminEnabled } from "@/lib/config/env";
import { getAdminRepository } from "@/lib/data/adminRepository";
import { MOCK_ADMIN_LOGIN_ID } from "@/lib/mocks/fixtures/adminSeed";
import type { AdminAccount, AdminSessionUser } from "@/lib/types/admin";

/**
 * 管理端认证服务 —— 管理登录页、管理页面与管理接口共用的唯一入口。
 *
 * 四条规则，本文件是它们唯一的落点：
 *
 * 1. **模拟登录不接收任何身份输入**。接口没有请求体、没有账号切换器，
 *    登录身份永远是 `MOCK_ADMIN_LOGIN_ID`。没有输入，就没有「提交
 *    `{"role":"admin"}` 就能变成管理员」的可能。
 * 2. **权限只认服务端会话**。`getAdminSession()` 从 Cookie 读账号 id、
 *    查管理仓储、再判断角色与启用状态；调用方（页面或接口）拿到的要么是
 *    一个合法的管理者，要么是 null / 明确的错误，不存在「客户端声明角色」这条路。
 * 3. **角色判断只有一处**：`canEnterAdminConsole()`。本文件不写 `role === "admin"`。
 * 4. **下发的一律是 DTO**。`AdminAccount` 里有 `enabled` 与 `lastLoginAt`，
 *    它们不出现在任何响应里（见 `toAdminSessionUser`）。
 */

/** 内部实体 → 会话 DTO。显式挑字段：`enabled` 与 `lastLoginAt` 不外泄。 */
export function toAdminSessionUser(account: AdminAccount): AdminSessionUser {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    roleLabel: adminRoleLabel(account.role),
  };
}

/**
 * 会话状态的完整判定结果。
 *
 * 分成三态而不是「有 / 没有」两态，是因为**页面与接口需要的粒度不同**：
 * 页面只关心「能不能进」，两态足够（都引导到登录页）；接口需要把
 * 「没登录」（401，去登录）与「登录了但没权限」（403，换账号也没用）分开。
 */
export type AdminSessionState =
  /** 没有有效会话：未登录、Cookie 里的 id 查不到账号、或开关未开启 */
  | { kind: "anonymous" }
  /** 带着一个有效的管理端账号，但这个账号不能进后台（停用，或角色不是 admin） */
  | { kind: "forbidden" }
  | { kind: "granted"; admin: AdminSessionUser };

/**
 * 判定当前管理端会话。
 *
 * ⚠️ `forbidden` 这一态**不告诉调用方具体原因**（停用？还是角色不对？）：
 * 区分两者等于给出一个可以探测「某个账号是否存在、是否被停用」的接口。
 * 对使用者来说结论一样——换账号也没用。
 */
export async function getAdminSessionState(): Promise<AdminSessionState> {
  const account = await getSessionAdmin();
  if (!account) return { kind: "anonymous" };

  if (!account.enabled || !canEnterAdminConsole(account.role)) return { kind: "forbidden" };

  return { kind: "granted", admin: toAdminSessionUser(account) };
}

/**
 * 当前管理端会话（页面侧使用）。
 *
 * 把 `anonymous` 与 `forbidden` **压成同一个 null** 是刻意的：页面对这两种情形的
 * 处置完全一样——渲染登录引导。页面不需要（也不应该）知道「差在哪」，
 * 那只会变成一屏「你的账号被停用了」的提示，等于确认了这个账号存在。
 */
export async function getAdminSession(): Promise<AdminSessionUser | null> {
  const state = await getAdminSessionState();
  return state.kind === "granted" ? state.admin : null;
}

/**
 * 模拟管理员登录。
 *
 * ⚠️ **不调用任何真实接口，也没有密码**：只是把固定的 Mock 账号 id 写进管理端 Cookie。
 * 整个能力由 `ENABLE_MOCK_ADMIN` 控制，未开启时按「接口不存在」抛 404
 * （不是 403——一个被关掉的接口应当表现为不存在，而不是「你被拒绝了」）。
 */
export async function loginMockAdmin(): Promise<AdminSessionUser> {
  if (!isMockAdminEnabled()) {
    throw new ApiError("NOT_FOUND", ADMIN_MOCK_LOGIN_DISABLED_MESSAGE, 404);
  }

  const repository = getAdminRepository();
  const account = await repository.findAdminById(MOCK_ADMIN_LOGIN_ID);

  // 预置数据缺失属于服务端问题，不是「账号被停用」
  if (!account) throw new ApiError("SERVER_ERROR", "模拟管理员账号不存在");

  if (!account.enabled) throw new ApiError("FORBIDDEN", ADMIN_FORBIDDEN_MESSAGE, 403);
  if (!canEnterAdminConsole(account.role)) {
    throw new ApiError("FORBIDDEN", ADMIN_FORBIDDEN_MESSAGE, 403);
  }

  await setSessionAdmin(account.id);
  // 审计信息：写失败不影响登录结果，因此不检查返回值
  await repository.markLoggedIn(account.id, new Date().toISOString());

  return toAdminSessionUser(account);
}

/**
 * 退出登录：删除管理端 Cookie，调用方随即回到未登录状态。
 *
 * ⚠️ **只删管理端 Cookie**，用户端会话完全不受影响——两者本来就是两个 Cookie。
 * 与登录接口一样由 `ENABLE_MOCK_ADMIN` 控制：未开启时本就不存在管理端会话，
 * 没有可登出的对象，按接口不存在返回 404。
 */
export async function logoutAdmin(): Promise<{ ok: true }> {
  if (!isMockAdminEnabled()) {
    throw new ApiError("NOT_FOUND", ADMIN_MOCK_LOGIN_DISABLED_MESSAGE, 404);
  }

  await clearSessionAdmin();
  return { ok: true };
}
