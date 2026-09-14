import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_STAFF_LIST_NOTICE,
  ADMIN_STAFF_NOT_FOUND_MESSAGE,
  ADMIN_STAFF_OPERATION_CONFLICT_MESSAGE,
  ADMIN_STAFF_REMOVED_MESSAGE,
  ADMIN_STAFF_STATE_INVALID_MESSAGE,
  ADMIN_STAFF_USERNAME_TAKEN_MESSAGE,
  DEFAULT_ADMIN_STAFF_STATE_FILTER,
  buildAdminStaffListQuery,
  compareStaffForAdmin,
  countStaffStates,
  normalizeStaffAvatar,
  normalizeStaffDisplayName,
  normalizeStaffUsername,
  readAdminStaffStateFilter,
  staffMatchesAdminKeyword,
  staffStateOf,
  toAdminStaffDetail,
  toAdminStaffListItem,
  type AdminStaffListQuery,
  type AdminStaffProfileInput,
} from "@/lib/constants/adminStaff";
import { IDEMPOTENCY_KEY_PATTERN, readIdempotencyKey, readTrimmedString } from "@/lib/constants/writes";
import {
  createStaffAccount,
  removeStaffAccount,
  setStaffEnabled,
  updateStaffProfile,
  type AdminStaffWriteFailure,
  type AdminWriteContext,
} from "@/lib/data/adminStaffTransaction";
import { getStaffRepository } from "@/lib/data/staffRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { AdminStaffDetail, AdminStaffListData, StaffAccount } from "@/lib/types/staff";

/**
 * 管理端「客服账号」服务 —— 列表、详情与五个写动作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：管理端权限判断只有一处（`lib/api/adminRoute.ts`）。
 *
 * ⚠️ 本文件**不认识客服端会话**：没有 `import` 自 `lib/auth/staffSession.ts`，
 * 也没有「把管理员换算成客服」的函数。管理员改了客服账号，不等于管理员本人
 * 拿到了客服权限——两者之间的唯一联系是那次改动下一次请求就会被客服端查到。
 *
 * ⚠️ **角色不由调用方决定**。`AdminStaffProfileInput` 里根本没有 `role` 字段，
 * 写死为 `customer_service` 的地方在 `lib/data/adminStaffTransaction.ts`。
 * 因此「请求体里塞 `role: "admin"` 就能建出一个管理员」不是「校验后拒绝」，
 * 而是「压根读不到」。
 *
 * ⚠️ **不保存真实密码**。客服账号里没有密码字段，也没有「重置密码」这个动作：
 * 本阶段是 Mock 认证，登录入口是一份测试账号列表（见 `/staff/login`）。
 * 页面上的 `ADMIN_STAFF_CREDENTIAL_NOTICE` 必须与这一条保持一致。
 */

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表查询条件。**接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化。
 *
 * 状态筛选会**改变查到的数据**，一个手改坏的值若静默按「全部」处理，
 * 页面会显示一批与筛选栏不符的账号——运营会以为某个账号不见了。
 */
export function resolveAdminStaffListQuery(
  params: URLSearchParams,
  strict: boolean,
): AdminStaffListQuery {
  const state = readAdminStaffStateFilter(params.get("state"));

  if (strict && state === null) {
    throw new ApiError("BAD_REQUEST", ADMIN_STAFF_STATE_INVALID_MESSAGE, 400);
  }

  return buildAdminStaffListQuery({
    params,
    state: state ?? DEFAULT_ADMIN_STAFF_STATE_FILTER,
  });
}

/**
 * 管理端客服账号列表。
 *
 * `?mockEmpty=staff` 演示空列表（空数据不是错误，不抛错，由页面渲染空态）；
 * `?mockError=…` 由 `withMockDebug` 统一处理。两者都只在 `ENABLE_MOCK_DEBUG=true` 时生效。
 *
 * ⚠️ `counts` 统计的是**全部账号**，不是当前筛选的结果：三个筛选按钮上的角标
 * 要回答的是「已停用的有几个」，而不是「在只显示已停用的列表里有几个已停用」。
 */
export async function queryAdminStaffList(
  query: AdminStaffListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminStaffListData> {
  return withMockDebug(params, surface, async () => {
    const accounts = await getStaffRepository().listStaff();
    const counts = countStaffStates(accounts);

    if (mockEmptyApplies(params, "staff")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        counts,
        notice: ADMIN_STAFF_LIST_NOTICE,
      };
    }

    const filtered = accounts
      .filter((account) => query.state === "all" || staffStateOf(account) === query.state)
      .filter((account) => staffMatchesAdminKeyword(account, query.keyword))
      .sort(compareStaffForAdmin);

    const start = (query.page - 1) * query.pageSize;
    const items = filtered.slice(start, start + query.pageSize).map(toAdminStaffListItem);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      hasMore: start + items.length < filtered.length,
      counts,
      notice: ADMIN_STAFF_LIST_NOTICE,
    };
  });
}

// ——————————————————————————— 详情 ———————————————————————————

/**
 * 管理端客服账号详情。不存在返回 null，由页面 `notFound()`。
 *
 * 比列表多两样服务端算好的结论：`role`（这条记录到底是什么角色）与
 * `canEnterStaffConsole`（能不能进客服工作台）。页面不自己判角色——
 * 判错了就是一个假的权限提示。
 */
export async function getAdminStaffDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminStaffDetail | null> {
  if (!id) return null;

  return withMockDebug(params, surface, async () => {
    const account = await getStaffRepository().findStaffById(id);
    if (!account) return null;
    return toAdminStaffDetail(account);
  });
}

// ——————————————————————————— 表单输入 ———————————————————————————

/**
 * 从请求体里取三个资料字段并逐字段校验。
 *
 * 三条规则与新增、编辑**完全一致**（`lib/constants/adminStaff.ts` 的三个
 * `normalize*` 函数）：登录名去空白后非空、长度有上限、字符集受限；
 * 名称去空白后非空；头像必须**在白名单里**。
 *
 * ⚠️ **唯一性不在这里判**：它要查仓储，属于伪事务的原子区段。
 * 这里的 `username-taken` 由写入侧返回，不是前端猜出来的。
 *
 * ⚠️ **角色与状态不在入参里**。请求体里的 `role` / `enabled` / `removedAt`
 * 读都不读：角色是服务端写死的，状态只能走启用 / 停用 / 移除三个明确动作。
 */
function readProfileInput(body: Record<string, unknown>): AdminStaffProfileInput {
  const username = normalizeStaffUsername(readTrimmedString(body, "username"));
  if (!username.ok) throw new ApiError("BAD_REQUEST", username.message, 400);

  const displayName = normalizeStaffDisplayName(readTrimmedString(body, "displayName"));
  if (!displayName.ok) throw new ApiError("BAD_REQUEST", displayName.message, 400);

  const avatarUrl = normalizeStaffAvatar(readString(body, "avatarUrl"));
  if (!avatarUrl.ok) throw new ApiError("BAD_REQUEST", avatarUrl.message, 400);

  return { username: username.value, displayName: displayName.value, avatarUrl: avatarUrl.value };
}

/**
 * 取一个字符串字段。
 *
 * 与 `readTrimmedString()` 的区别：头像要去空白之后**再比对白名单**，
 * 因此这里原样取出、不做 trim，由 `normalizeStaffAvatar()` 统一处理。
 * 非字符串（数字、对象、缺失）一律当作空串——它会因为不在白名单里被拒，
 * 不会因为类型不对而抛出另一种错误。
 */
function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

// ——————————————————————————— 五个写动作 ———————————————————————————

/**
 * 从请求体里取幂等键。
 *
 * ⚠️ **不能依赖按钮禁用防重**：按钮只能挡住手快，挡不住网络重试与用户刷新后重发，
 * 也挡不住直接请求接口。真正的防重是这里读到的幂等键，加上伪事务里的重放判定。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key) throw new ApiError("BAD_REQUEST", "缺少幂等键", 400);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", "幂等键格式不合法", 400);
  }
  return key;
}

/** 组装一次写操作的上下文。时间戳只取一次，业务写入与审计写入共用同一个。 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return { adminId, operationId, at: new Date().toISOString() };
}

/** 五个动作共用的失败翻译。四种情形在所有动作里完全相同，写五遍只会写出五种口径。 */
function toApiError(outcome: AdminStaffWriteFailure): ApiError {
  switch (outcome.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_STAFF_NOT_FOUND_MESSAGE, 404);
    case "removed":
      return new ApiError("BAD_REQUEST", ADMIN_STAFF_REMOVED_MESSAGE, 400);
    case "username-taken":
      return new ApiError("BAD_REQUEST", ADMIN_STAFF_USERNAME_TAKEN_MESSAGE, 400);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_STAFF_OPERATION_CONFLICT_MESSAGE, 400);
  }
}

/** 伪事务的结果 → 接口返回。**返回的是详情 DTO**：写完之后页面要能直接刷新显示。 */
function toWriteResult(account: StaffAccount, changed: boolean): {
  staff: AdminStaffDetail;
  changed: boolean;
} {
  return { staff: toAdminStaffDetail(account), changed };
}

/**
 * 新增客服账号。
 *
 * 幂等键走「新建」语义（`takeCreateReplay`）：同一个键第二次到达时，
 * 返回的是**第一次建出来的那条账号**，而不是又建一条。
 */
export async function createAdminStaff(
  adminId: string,
  body: Record<string, unknown>,
): Promise<{ staff: AdminStaffDetail; changed: boolean }> {
  const operationId = requireIdempotencyKey(body);
  const input = readProfileInput(body);

  const outcome = await createStaffAccount(input, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value, outcome.changed);
}

/**
 * 编辑客服账号资料。
 *
 * ⚠️ **不碰状态**：启用 / 停用 / 移除各有自己的接口。编辑时顺手写状态，
 * 两位管理员同时操作时后写的那次会把另一位刚停用的账号重新启用。
 */
export async function updateAdminStaff(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<{ staff: AdminStaffDetail; changed: boolean }> {
  const operationId = requireIdempotencyKey(body);
  const input = readProfileInput(body);

  const outcome = await updateStaffProfile(id, input, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value, outcome.changed);
}

/**
 * 启用一个客服账号。
 *
 * 启用只把 `enabled` 打开，**不重置任何资料**：登录名、名称、头像、上次登录时间
 * 一个都不变。已移除的账号不能启用——移除是软删除，不是可以来回拨的开关。
 */
export async function enableAdminStaff(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<{ staff: AdminStaffDetail; changed: boolean }> {
  const operationId = requireIdempotencyKey(body);

  const outcome = await setStaffEnabled(id, true, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value, outcome.changed);
}

/**
 * 停用一个客服账号。
 *
 * ⚠️ **停用后立即失去客服工作台权限**，现有客服端 Cookie 也失效——靠的是
 * 客服端每个请求都重新查一次账号状态（见 `lib/services/staffAuth.ts`），
 * 而不是靠这里去删什么会话。本阶段没有会话表可删。
 *
 * 重复停用不是错误：已经停用了就不写时间戳、不写第二条审计。
 */
export async function disableAdminStaff(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<{ staff: AdminStaffDetail; changed: boolean }> {
  const operationId = requireIdempotencyKey(body);

  const outcome = await setStaffEnabled(id, false, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value, outcome.changed);
}

/**
 * 移除客服账号（**软删除**）。
 *
 * ⚠️ **不删除记录**：只写 `removedAt` 并同时停用。历史消息要保留，
 * 而且后台要能回答「这条消息当时是谁发的」——硬删除会让这个问题永久无解。
 *
 * 已经移除过：不刷新时间戳、不写第二条审计。重复移除是幂等的，不是错误。
 */
export async function removeAdminStaff(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<{ staff: AdminStaffDetail; changed: boolean }> {
  const operationId = requireIdempotencyKey(body);

  const outcome = await removeStaffAccount(id, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value, outcome.changed);
}
