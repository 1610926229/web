import { ApiError } from "@/lib/api/ApiError";
import { clearSessionStaff, getSessionStaff, setSessionStaff } from "@/lib/auth/staffSession";
import { isMockStaffEnabled } from "@/lib/config/env";
import { getStaffRepository } from "@/lib/data/staffRepository";
import {
  STAFF_FORBIDDEN_MESSAGE,
  STAFF_MOCK_LOGIN_DISABLED_MESSAGE,
  canEnterStaffConsole,
  staffRoleLabel,
} from "@/lib/constants/staff";
import type { StaffAccount, StaffLoginOption, StaffSessionState, StaffSessionUser } from "@/lib/types/staff";

/**
 * 客服端认证服务 —— 客服登录页、工作台页面与客服接口共用的唯一入口。
 *
 * 五条规则，本文件是它们唯一的落点：
 *
 * 1. **权限只认服务端会话**。`getStaffSessionState()` 从 Cookie 读账号 id、查客服仓储、
 *    再判断「启用 + 未移除 + 角色是客服」；调用方拿到的要么是一个合法的客服，
 *    要么是 null / 明确的错误。不存在「客户端声明角色」这条路。
 * 2. **每次请求都重新判定**（§三 明确要求）。本文件不缓存账号、不缓存会话状态：
 *    停用或移除之后，旧 Cookie 在**下一次请求**就失效。
 * 3. **三种被拒绝的登录**分开表达：账号不存在 / 已停用 / 已移除 → 403，
 *    角色不是客服 → 403，**开关关闭 → 404**。关闭的接口应当表现为「不存在」，
 *    而不是「你被拒绝了」——后者会让人以为换个账号就能进。
 * 4. **角色判断只有一处**：`canEnterStaffConsole()`。本文件不写 `role === "customer_service"`。
 * 5. **下发的一律是 DTO**。`StaffAccount` 里的 `enabled` / `removedAt` / `lastLoginAt`
 *    不出现在会话响应里（见 `toStaffSessionUser`）。
 *
 * ⚠️ 本文件**不认识用户端与管理端的任何东西**：没有 `import` 自
 * `lib/services/userAuth.ts` 或 `adminAuth.ts`，也没有互相转换身份的函数。
 * 三类身份之间的隔离靠的就是「代码里不存在那条路」，而不是靠运行时判断。
 */

/** 内部实体 → 会话 DTO。显式挑字段：`enabled` / `removedAt` / `lastLoginAt` 不外泄。 */
export function toStaffSessionUser(account: StaffAccount): StaffSessionUser {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    role: account.role,
    roleLabel: staffRoleLabel(account.role),
  };
}

/**
 * 一个账号能不能进客服工作台。
 *
 * ⚠️ **三个条件缺一不可**，而且判断集中在这一处：启用中、未移除、角色是客服。
 * 分散成 `if` 写在调用方，迟早会有一处漏掉 `removedAt`——而漏掉的那一处
 * 正好就是「已删除账号还能登录」。
 */
export function canStaffSignIn(account: StaffAccount): boolean {
  return account.enabled && account.removedAt === null && canEnterStaffConsole(account.role);
}

/**
 * 判定当前客服端会话。
 *
 * ⚠️ `forbidden` 这一态**不告诉调用方具体原因**（停用？已移除？还是角色不对？）：
 * 区分它们等于给出一个可以探测「某个账号是否存在、是否被停用」的接口。
 * 对使用者来说结论一样——换账号也没用。
 */
export async function getStaffSessionState(): Promise<StaffSessionState> {
  const account = await getSessionStaff();
  if (!account) return { kind: "anonymous" };

  if (!canStaffSignIn(account)) return { kind: "forbidden" };

  return { kind: "granted", staff: toStaffSessionUser(account) };
}

/**
 * 当前客服端会话（页面侧使用）。
 *
 * 把 `anonymous` 与 `forbidden` **压成同一个 null** 是刻意的：页面对这两种情形的
 * 处置完全一样——引导到客服登录页。页面不需要（也不应该）知道「差在哪」。
 */
export async function getStaffSession(): Promise<StaffSessionUser | null> {
  const state = await getStaffSessionState();
  return state.kind === "granted" ? state.staff : null;
}

/**
 * 客服登录页可选的测试账号。
 *
 * ⚠️ 只列**能登录的**账号（启用 + 未移除 + 角色是客服），而且**只在开关打开时**列：
 * 列出停用或已移除的账号，等于给出一个「点了一定失败」的入口，
 * 也等于泄漏了这些账号存在。
 *
 * ⚠️ 这份名单**只喂给 `/staff/login`**，不进用户端任何页面：用户前台不提供账号切换器。
 * 校验仍然在 `loginMockStaff()` 里重做一遍——列表只是「有哪些可选」，
 * 不是「这些一定登录得上」的依据（列表渲染之后账号可能正好被停用）。
 */
export async function getStaffLoginOptions(): Promise<StaffLoginOption[]> {
  if (!isMockStaffEnabled()) return [];

  const accounts = await getStaffRepository().listStaff();
  return accounts
    .filter(canStaffSignIn)
    .map((account): StaffLoginOption => ({
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      lastLoginAt: account.lastLoginAt,
    }));
}

/**
 * 模拟客服登录。
 *
 * ⚠️ **不调用任何真实接口，也没有密码**：只是把选中的 Mock 客服账号 id 写进客服端 Cookie。
 * 请求里唯一的输入是 `staffId`，**它不是身份来源**——服务端拿它去仓储查账号，
 * 查到的记录才决定这个人能做什么。因此提交一个别的 id 只会得到「查不到」或
 * 「这个账号不能登录」，不会得到「以这个身份登录」。
 *
 * 整个能力由 `ENABLE_MOCK_STAFF` 控制，未开启时按「接口不存在」抛 404。
 */
/**
 * 客服端 Mock 能力的总闸：未开启 `ENABLE_MOCK_STAFF` 时抛 404（接口不存在）。
 *
 * ⚠️ 单独导出是为了让**路由能在读请求体之前**先过闸。接口层读体会先校验
 * 「请求体是不是合法 JSON」，于是「开关关闭」与「请求体畸形」撞在一起时，
 * 后者会先返回 400 —— 那等于告诉对方「这个接口是存在的，只是你没发对」。
 * 开关关闭的含义是接口不存在，它必须比请求校验先说话。
 * 用户端 `/api/auth/mock-login` 就是这个次序，这里与它对齐。
 *
 * 服务函数内部仍然各自调用一次：路由过闸不构成对直接调用者的保护。
 */
export function assertMockStaffEnabled(): void {
  if (!isMockStaffEnabled()) {
    throw new ApiError("NOT_FOUND", STAFF_MOCK_LOGIN_DISABLED_MESSAGE, 404);
  }
}

export async function loginMockStaff(staffId: string): Promise<StaffSessionUser> {
  assertMockStaffEnabled();

  const id = staffId.trim();
  if (!id) throw new ApiError("BAD_REQUEST", "请选择要登录的客服账号");

  const account = await getStaffRepository().findStaffById(id);

  // ⚠️ 「查不到」「已停用」「已移除」「角色不是客服」给的是**同一句话同一个状态码**：
  // 区分它们等于给出一个可以探测某个客服账号是否存在、是否被停用的接口。
  // 对使用者来说结论一样——换账号也没用。
  if (!account || !canStaffSignIn(account)) {
    throw new ApiError("FORBIDDEN", STAFF_FORBIDDEN_MESSAGE, 403);
  }

  await setSessionStaff(account.id);
  // 审计信息：写失败不影响登录结果，因此不检查返回值。
  // ⚠️ 这里写的是 `lastLoginAt`，**不写管理审计**：客服登录不是一次管理写操作，
  // 而且 `staff.update` 那条审计的意思是「管理员改了资料」，不能被登录刷屏。
  await getStaffRepository().markLoggedIn(account.id, new Date().toISOString());

  return toStaffSessionUser(account);
}

/**
 * 退出登录：删除客服端 Cookie，调用方随即回到未登录状态。
 *
 * ⚠️ **只删客服端 Cookie**，用户端与管理端会话完全不受影响——三者本来就是三个 Cookie。
 * 与登录接口一样由 `ENABLE_MOCK_STAFF` 控制：未开启时本就不存在客服端会话，
 * 没有可登出的对象，按接口不存在返回 404。
 */
export async function logoutStaff(): Promise<{ ok: true }> {
  assertMockStaffEnabled();

  await clearSessionStaff();
  return { ok: true };
}
