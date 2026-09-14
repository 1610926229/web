import { clampPage, clampPageSize } from "@/lib/constants/pagination";
import { MOCK_AVATAR_OPTIONS } from "@/lib/constants/profile";
import { canEnterStaffConsole, staffRoleLabel } from "@/lib/constants/staff";
import type { AdminStaffDetail, AdminStaffListItem, AdminStaffState, StaffAccount } from "@/lib/types/staff";
import { countCharacters } from "@/lib/utils/text";

/**
 * 管理端「客服账号」的规则、文案与 DTO 映射（服务端与浏览器共用）。
 *
 * ⚠️ 本文件是**管理端**的：它管的是「谁可以登录客服工作台」，
 * 不是「客服在工作台里能看什么」。后者在 `lib/constants/staff.ts`。
 * 两个文件都不引用用户端会话，也不做任何「把用户换算成客服」的换算。
 *
 * 三条规则只在这里判断一次：
 *
 * 1. **登录名**去空白后不能为空、长度有上限、字符集受限，且**大小写不敏感唯一**；
 * 2. **角色**：管理端只能建出 `customer_service`。角色不是表单字段，是服务端写死的
 *    （见 `lib/services/adminStaff.ts`），因此「请求体里塞 `role: "admin"` 就建出一个
 *    管理员」在这条链路上没有可以落脚的字段；
 * 3. **状态**：启用 / 停用 / 已移除三态互斥，由 `staffStateOf()` 从记录推导，
 *    页面不自己拼。
 */

// ——————————————————————————— 文案 ———————————————————————————

export const ADMIN_STAFF_PAGE_TITLE = "客服账号";
export const ADMIN_STAFF_CREATE_PAGE_TITLE = "新增客服账号";
export const ADMIN_STAFF_DETAIL_PAGE_TITLE = "客服账号详情";
export const ADMIN_STAFF_LIST_TITLE = "客服账号列表";

/**
 * 列表页顶部的说明。
 *
 * 必须说清「客服账号不是普通用户」：运营在后台看到一行账号，
 * 不能以为这是在给某个用户开权限。
 */
export const ADMIN_STAFF_LIST_NOTICE =
  "客服账号是独立于用户与管理员的第三类身份：不参与消费、不进排行榜、不出现在任何用户端名单里，" +
  "只能登录客服工作台。删除是软删除——记录与历史消息都保留，可以在这里筛出来查看。";

/**
 * 登录相关的边界说明。
 *
 * ⚠️ 本阶段**不保存真实密码**：页面提供的是一个固定的测试登录入口，
 * 不给任何人输入密码的地方。这句话必须出现在新增页与详情页上，
 * 否则「新增了一个客服账号」很容易被理解成「可以拿这个账号密码登录真实系统」。
 */
export const ADMIN_STAFF_CREDENTIAL_NOTICE =
  "本阶段为 Mock 认证：不保存任何真实密码，也没有密码输入框。新增后请到 /staff/login 的测试账号列表里选择它进入工作台。";

export const ADMIN_STAFF_LIST_FIELDS_NOTE =
  "列表不含 Cookie、密码或任何会话标识——这些数据在客服账号里根本不存在。";

export const ADMIN_STAFF_EMPTY_MESSAGE = "当前筛选下没有客服账号。";

export const ADMIN_STAFF_EDIT_TITLE = "编辑客服账号";
export const ADMIN_STAFF_CREATE_TITLE = "新增客服账号";
export const ADMIN_STAFF_SAVE_LABEL = "保存资料";
export const ADMIN_STAFF_CREATE_LABEL = "创建账号";
export const ADMIN_STAFF_EDIT_TITLE_HINT =
  "这里只能改资料三件套（登录名 / 客服名称 / 头像）。启用、停用与移除不在这个表单里——" +
  "那三个动作各自有接口，顺手写状态会让两个人同时操作时，后写的那次把刚停用的账号又启用回去。";

// ——————————————————————————— 状态 ———————————————————————————

export const ADMIN_STAFF_STATE_LABELS: Record<AdminStaffState, string> = {
  enabled: "启用中",
  disabled: "已停用",
  removed: "已移除",
};

/**
 * 记录 → 状态。**已移除优先于启用 / 停用**：一条已移除的记录说「已停用」会让人
 * 以为还能重新启用它，而移除是不可回退的软删除。
 */
export function staffStateOf(account: Pick<StaffAccount, "enabled" | "removedAt">): AdminStaffState {
  if (account.removedAt !== null) return "removed";
  return account.enabled ? "enabled" : "disabled";
}

export function staffStateLabel(state: AdminStaffState): string {
  return ADMIN_STAFF_STATE_LABELS[state];
}

/** 列表筛选：`all` + 三种状态。默认全部。 */
export type AdminStaffStateFilter = AdminStaffState | "all";

export const ADMIN_STAFF_STATE_FILTERS: readonly AdminStaffStateFilter[] = [
  "all",
  "enabled",
  "disabled",
  "removed",
];

export const ADMIN_STAFF_STATE_FILTER_LABELS: Record<AdminStaffStateFilter, string> = {
  all: "全部状态",
  ...ADMIN_STAFF_STATE_LABELS,
};

export const DEFAULT_ADMIN_STAFF_STATE_FILTER: AdminStaffStateFilter = "all";

export const ADMIN_STAFF_STATE_INVALID_MESSAGE = "筛选条件 state 只能是 all / enabled / disabled / removed";

export function isAdminStaffStateFilter(value: string): value is AdminStaffStateFilter {
  return (ADMIN_STAFF_STATE_FILTERS as readonly string[]).includes(value);
}

/** 解析状态筛选；非法值返回 null（接口转 400，页面回退默认值）。 */
export function readAdminStaffStateFilter(raw: string | null): AdminStaffStateFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_STAFF_STATE_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_STAFF_STATE_FILTER;
  return isAdminStaffStateFilter(value) ? value : null;
}

export function normalizeAdminStaffStateFilter(raw: string | null): AdminStaffStateFilter {
  return readAdminStaffStateFilter(raw) ?? DEFAULT_ADMIN_STAFF_STATE_FILTER;
}

/** 三个状态各有多少条。**已移除的记录只进 `removed`**，不进前两个数。 */
export function countStaffStates(accounts: readonly StaffAccount[]): {
  enabled: number;
  disabled: number;
  removed: number;
  total: number;
} {
  let enabled = 0;
  let disabled = 0;
  let removed = 0;

  for (const account of accounts) {
    const state = staffStateOf(account);
    if (state === "removed") removed += 1;
    else if (state === "enabled") enabled += 1;
    else disabled += 1;
  }

  return { enabled, disabled, removed, total: accounts.length };
}

// ——————————————————————————— 列表查询 ———————————————————————————

export const ADMIN_STAFF_PAGE_SIZE = 20;
export const ADMIN_STAFF_MAX_PAGE_SIZE = 100;
export const ADMIN_STAFF_MAX_PAGE = 1000;

export type AdminStaffListQuery = {
  keyword: string;
  state: AdminStaffStateFilter;
  page: number;
  pageSize: number;
};

/** 关键字**只去空白，不截断、不设上限**：与订单 / 会话搜索同一条规则。 */
export function readAdminStaffKeyword(raw: string | null): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function buildAdminStaffListQuery(input: {
  params: URLSearchParams;
  state: AdminStaffStateFilter;
}): AdminStaffListQuery {
  return {
    keyword: readAdminStaffKeyword(input.params.get("keyword")),
    state: input.state,
    page: clampPage(input.params.get("page"), ADMIN_STAFF_MAX_PAGE),
    pageSize: clampPageSize(input.params.get("pageSize"), ADMIN_STAFF_PAGE_SIZE, ADMIN_STAFF_MAX_PAGE_SIZE),
  };
}

/** 关键字是否命中登录名或客服名称（大小写不敏感）。 */
export function staffMatchesAdminKeyword(account: StaffAccount, keyword: string): boolean {
  const value = keyword.trim().toLowerCase();
  if (!value) return true;
  return (
    account.username.toLowerCase().includes(value) ||
    account.displayName.toLowerCase().includes(value)
  );
}

/**
 * 列表排序：**新建的排最前**，同一时间按 id 升序兜底。
 *
 * 兜底那一步不是可有可无的：预置数据的 `createdAt` 都是同一个时间戳，
 * 少了它，翻页时同一条记录可能在两页里各出现一次。
 */
export function compareStaffForAdmin(a: StaffAccount, b: StaffAccount): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// ——————————————————————————— DTO ———————————————————————————

/** 记录 → 列表项。**显式挑字段**：没有 Cookie、密码、会话标识，也没有角色原始取值。 */
export function toAdminStaffListItem(account: StaffAccount): AdminStaffListItem {
  const state = staffStateOf(account);
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    roleLabel: staffRoleLabel(account.role),
    state,
    stateLabel: staffStateLabel(state),
    lastLoginAt: account.lastLoginAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    removedAt: account.removedAt,
  };
}

/**
 * 记录 → 详情。
 *
 * 比列表多两样，而且都是**服务端算好的结论**：
 * `role`（原始取值，页面要能看出这条记录到底是不是客服）与
 * `canEnterStaffConsole`（页面不自己判角色，判错了就是一个假的权限提示）。
 */
export function toAdminStaffDetail(account: StaffAccount): AdminStaffDetail {
  return {
    ...toAdminStaffListItem(account),
    role: account.role,
    canEnterStaffConsole: account.enabled && account.removedAt === null && canEnterStaffConsole(account.role),
  };
}

// ——————————————————————————— 表单校验 ———————————————————————————

/**
 * 登录名长度上限。
 *
 * 只做上限、不做下限：真正的下限是「去空白后不能为空」，
 * 再定一个「至少 3 个字符」只会让测试账号难记。
 */
export const ADMIN_STAFF_USERNAME_MAX_LENGTH = 32;
/** 客服名称长度上限。与陪玩昵称同为 20。 */
export const ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH = 20;

/**
 * 登录名字符集。
 *
 * 限制字符集不是为了安全（有唯一索引与转义），而是为了**可读性**：
 * 允许空格与 Emoji 之后，列表里会出现「kefu 小雨」与「kefu小雨」两条看起来
 * 一样的账号，运营分不清哪个是哪个。
 */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export const ADMIN_STAFF_USERNAME_EMPTY_MESSAGE = "请填写登录名";
export const ADMIN_STAFF_USERNAME_TOO_LONG_MESSAGE =
  `登录名不能超过 ${ADMIN_STAFF_USERNAME_MAX_LENGTH} 个字符`;
export const ADMIN_STAFF_USERNAME_INVALID_MESSAGE = "登录名只能包含字母、数字、连字符（-）与下划线（_）";
export const ADMIN_STAFF_USERNAME_TAKEN_MESSAGE = "这个登录名已被占用（不区分大小写）";
export const ADMIN_STAFF_DISPLAY_NAME_EMPTY_MESSAGE = "请填写客服名称";
export const ADMIN_STAFF_DISPLAY_NAME_TOO_LONG_MESSAGE =
  `客服名称不能超过 ${ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH} 个字符`;
export const ADMIN_STAFF_AVATAR_INVALID_MESSAGE = "头像只能是白名单里的 Mock 占位图";

export const ADMIN_STAFF_NOT_FOUND_MESSAGE = "客服账号不存在";
export const ADMIN_STAFF_REMOVED_MESSAGE = "账号已移除，不能再编辑或改变状态";
export const ADMIN_STAFF_OPERATION_CONFLICT_MESSAGE = "这个幂等键已经被另一个对象用过";

/** 表单输入。三个字段都由管理端填写；`role` **不在其中**（服务端写死为客服）。 */
export type AdminStaffProfileInput = {
  username: string;
  displayName: string;
  avatarUrl: string;
};

/** 逐字段错误。`null` 表示该字段没有错误。 */
export type AdminStaffProfileFieldErrors = {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * 表单字段的固定顺序。
 *
 * ⚠️ **顺序即页面上从上到下的顺序**，也是「第一条错误自动聚焦」的依据：
 * `Object.keys()` 的顺序虽然在现代 JS 里是稳定的，但把顺序写成一个显式数组，
 * 是为了让「先看登录名、再看名称、最后看头像」这件事在代码里有出处，
 * 而不是依赖某个对象字面量的书写次序。
 */
export const ADMIN_STAFF_PROFILE_FIELDS = ["username", "displayName", "avatarUrl"] as const;

export type AdminStaffProfileField = (typeof ADMIN_STAFF_PROFILE_FIELDS)[number];

export const ADMIN_STAFF_PROFILE_FIELD_LABELS: Record<AdminStaffProfileField, string> = {
  username: "登录名",
  displayName: "客服名称",
  avatarUrl: "头像",
};

/** 第一条出错的字段；全部通过时返回 null。 */
export function firstAdminStaffProfileErrorField(
  errors: AdminStaffProfileFieldErrors,
): AdminStaffProfileField | null {
  return ADMIN_STAFF_PROFILE_FIELDS.find((field) => errors[field] !== null) ?? null;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 登录名的规范化与校验。
 *
 * ⚠️ **只 trim，不改大小写**：登录名会原样显示在列表与审计里，
 * 把它统一转成小写会让人认不出自己填的是什么；唯一性判断另外做一次
 * 大小写不敏感的比较（`findStaffByUsername`）。
 */
export function normalizeStaffUsername(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: ADMIN_STAFF_USERNAME_EMPTY_MESSAGE };
  if (countCharacters(value) > ADMIN_STAFF_USERNAME_MAX_LENGTH) {
    return { ok: false, message: ADMIN_STAFF_USERNAME_TOO_LONG_MESSAGE };
  }
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, message: ADMIN_STAFF_USERNAME_INVALID_MESSAGE };
  }
  return { ok: true, value };
}

export function normalizeStaffDisplayName(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: ADMIN_STAFF_DISPLAY_NAME_EMPTY_MESSAGE };
  if (countCharacters(value) > ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, message: ADMIN_STAFF_DISPLAY_NAME_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

/** 头像必须**在白名单里**：与用户资料、护航资料共用同一组本地占位图。 */
export function normalizeStaffAvatar(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!MOCK_AVATAR_OPTIONS.includes(value)) {
    return { ok: false, message: ADMIN_STAFF_AVATAR_INVALID_MESSAGE };
  }
  return { ok: true, value };
}

/**
 * 推导表单各字段的错误。
 *
 * 与护航编辑表单同一套做法：**逐字段给出一条**最终会生效的错误，
 * 页面拿它做 `aria-invalid` / `aria-describedby`，并把第一条出错的字段聚焦过去。
 * 校验顺序即页面上的字段顺序——「第一条错误」因此是「最靠上的那条」。
 *
 * ⚠️ **唯一性不在这里判**：它要查仓储，属于服务端的活（`lib/services/adminStaff.ts`）。
 * 页面上的「已被占用」是服务端返回后的结果，不是前端猜出来的。
 */
export function staffProfileFieldErrors(input: AdminStaffProfileInput): AdminStaffProfileFieldErrors {
  const username = normalizeStaffUsername(input.username);
  const displayName = normalizeStaffDisplayName(input.displayName);
  const avatarUrl = normalizeStaffAvatar(input.avatarUrl);

  return {
    username: username.ok ? null : username.message,
    displayName: displayName.ok ? null : displayName.message,
    avatarUrl: avatarUrl.ok ? null : avatarUrl.message,
  };
}

export function hasStaffProfileError(errors: AdminStaffProfileFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/** 三个字段是否与当前记录完全一致。一致就不写数据、不写审计（重复提交不是错误）。 */
export function isStaffProfileUnchanged(
  account: Pick<StaffAccount, "username" | "displayName" | "avatarUrl">,
  input: AdminStaffProfileInput,
): boolean {
  return (
    account.username === input.username.trim() &&
    account.displayName === input.displayName.trim() &&
    account.avatarUrl === input.avatarUrl.trim()
  );
}

/**
 * 「这个账号现在能不能进工作台」的展示口径。
 *
 * ⚠️ 入参是**详情 DTO 上已经算好的两个结论**（`state` 与 `canEnterStaffConsole`），
 * 不是记录上的 `enabled` / `removedAt`：页面拿到的是 DTO，
 * 而「已移除优先于已停用」这条判断只在 `staffStateOf()` 里写一次。
 * 页面自己拿 `enabled` 推，就会出现「列表说已移除、详情说已停用」。
 *
 * 前两个分支看 `state`，最后一个看 `canEnterStaffConsole`：两者同源，
 * 而在 `state === "enabled"` 时，`canEnterStaffConsole` 为假**只可能是角色不对**
 * （`toAdminStaffDetail()` 里已经算过启用与移除）。
 */
export function staffLoginabilityNotice(
  account: Pick<AdminStaffDetail, "state" | "canEnterStaffConsole">,
): string {
  if (account.state === "removed") return "账号已移除：不能登录，历史消息仍保留。";
  if (account.state === "disabled") return "账号已停用：不能登录，已有会话 Cookie 也已失效。";
  if (!account.canEnterStaffConsole) return "该角色不能进入客服工作台。";
  return "账号可用：可以在 /staff/login 选择它进入客服工作台。";
}
