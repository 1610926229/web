import { COMPANION_SERVICE_TAGS } from "@/lib/constants/companionApplications";
import { MOCK_AVATAR_OPTIONS } from "@/lib/constants/profile";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type {
  AdminCompanionListItem,
  AdminCompanionProfilePatch,
  Companion,
  CompanionGameOption,
} from "@/lib/types/companion";
import { countCharacters } from "@/lib/utils/text";
import { compareCompanionsForList, companionMatchesKeyword } from "./companions";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 管理端「护航管理」的筛选规则、编辑白名单与状态口径（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型、`./companions`、`./pagination`、`lib/constants/profile`
 * 与 `lib/utils/text.ts` 外没有运行时依赖，客户端组件引用它不会把服务端模块
 * 打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 四组规则写在这里，它们都是 §八 的直接落点：
 *
 * 1. **编辑白名单**：`normalizeCompanionProfilePatch()` 是「客户端能改什么」的
 *    唯一实现。统计、关联用户、来源申请、移除时间**不在入参类型里**，
 *    因此不存在「忘了校验」这条路径。
 * 2. **三种「不接单」的区别**（最容易被做成一件事，所以在这里写清楚）：
 *    - **暂停接单**：`enabled: true` + `available: false` + 原因。仍然在名单里、
 *      详情页正常可见，只是结算时不可选；
 *    - **停用**：`enabled: false`（并强制 `available: false`）。不在公开名单里，
 *      直链打开详情是一页只读的「当前不可提供服务」；
 *    - **移除**：写 `removedAt`（软删除）。用户端完全看不到，后台可用「已移除」筛选到，
 *      历史订单、评价与鸡腿记录一条都不删。
 * 3. **游戏与大区必须匹配**：大区必须属于所选游戏之一，与入驻申请表单同一条规则。
 * 4. **危险操作都要二次确认**：确认文案在这里，但确认框**不是**防重手段——
 *    真正的防重是服务端的幂等键与状态判断（§九：不能依赖按钮禁用防重）。
 */

export const ADMIN_COMPANION_DETAIL_TITLE = "护航详情";
export const ADMIN_COMPANION_EDIT_TITLE = "编辑护航资料";

export const ADMIN_COMPANION_LIST_NOTICE =
  "这里的编辑会立即影响用户端的陪玩列表、详情页与结算页——三处读的是同一份数据。";

export const ADMIN_COMPANION_EMPTY_MESSAGE = "当前筛选下没有护航记录。";
export const ADMIN_COMPANION_DETAIL_FORBIDDEN_EDIT_NOTICE =
  "统计（评分、完成单数、评价数、鸡腿数）、关联用户与来源申请由系统维护，页面只能查看。";

/** 列表默认每页条数。 */
export const ADMIN_COMPANION_PAGE_SIZE = 10;
export const ADMIN_COMPANION_MAX_PAGE_SIZE = 50;
export const ADMIN_COMPANION_MAX_PAGE = 1000;

// ——————————————————————————— 新护航的默认值（§七） ———————————————————————————

/**
 * 审核通过新建的护航，`available` 一律为 `false`，原因就是这一句。
 *
 * 「资料待完善」是**如实描述**：新护航只有昵称、游戏、大区、标签与自我介绍，
 * 没有评价、没有历史订单，平台也还没有确认它的可接单安排。直接置为可接单
 * 等于替平台承诺了一件没人确认过的事。
 */
export const NEW_COMPANION_UNAVAILABLE_REASON = "资料待完善";

/**
 * 新护航的 `rankLabel`。
 *
 * 预置陪玩的「钻石打手 / 星耀打手」是 Mock 的分级展示，**新护航没有分级**——
 * 给它安一个「钻石打手」，就是凭空发明了一条平台还没定的规则。
 * 这里给的是一个状态描述而不是等级，且只在结算面板里作为一行小字出现。
 */
export const NEW_COMPANION_RANK_LABEL = "新入驻护航";

/** 新护航的默认头像：从白名单里取第一个，后台可以随时换成别的。 */
export const NEW_COMPANION_AVATAR_URL = MOCK_AVATAR_OPTIONS[0];

// ——————————————————————————— 状态筛选 ———————————————————————————

/**
 * 状态筛选（地址栏参数名 `state`，与概览卡片的链接一致）。
 *
 * `unavailable` 的口径与概览的「暂不可接单护航」**完全一致**：只统计
 * **已启用但当前接不了单**的记录（`countCompanionStates()`）。
 * 把停用记录也算进来的话，这个筛选和概览数字会对不上，
 * 而且「暂不可接单」这句话对一条下架记录本来就不成立。
 */
export type AdminCompanionStateFilter = "all" | "enabled" | "disabled" | "unavailable";

export const ADMIN_COMPANION_STATE_FILTERS: readonly AdminCompanionStateFilter[] = [
  "all",
  "enabled",
  "disabled",
  "unavailable",
];

export const ADMIN_COMPANION_STATE_FILTER_LABELS: Record<AdminCompanionStateFilter, string> = {
  all: "全部状态",
  enabled: "已启用",
  disabled: "已停用",
  unavailable: "暂不可接单",
};

export const DEFAULT_ADMIN_COMPANION_STATE_FILTER: AdminCompanionStateFilter = "all";

export const ADMIN_COMPANION_STATE_INVALID_MESSAGE =
  "筛选条件 state 只能是 all / enabled / disabled / unavailable";

/**
 * 状态筛选 → 数据层的两个维度。
 *
 * 页面只认一个 `state` 参数（概览卡片的链接就是这么给的），
 * 数据层认的是 `enabled` 与 `availability` 两个独立的过滤条件。
 * 两者的换算只写在这里一处，页面与接口都不自己拆。
 */
export function adminCompanionStateToFilter(state: AdminCompanionStateFilter): {
  enabled: "" | "enabled" | "disabled";
  availability: "" | "available" | "unavailable";
} {
  switch (state) {
    case "enabled":
      return { enabled: "enabled", availability: "" };
    case "disabled":
      return { enabled: "disabled", availability: "" };
    case "unavailable":
      // 只有「已启用」的记录才谈得上「暂不可接单」
      return { enabled: "enabled", availability: "unavailable" };
    default:
      return { enabled: "", availability: "" };
  }
}

export function isAdminCompanionStateFilter(value: string): value is AdminCompanionStateFilter {
  return (ADMIN_COMPANION_STATE_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口抛 400）。空值按默认筛选处理。 */
export function readAdminCompanionStateFilter(
  raw: string | null,
): AdminCompanionStateFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_COMPANION_STATE_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_COMPANION_STATE_FILTER;
  return isAdminCompanionStateFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeAdminCompanionStateFilter(raw: string | null): AdminCompanionStateFilter {
  return readAdminCompanionStateFilter(raw) ?? DEFAULT_ADMIN_COMPANION_STATE_FILTER;
}

// ——————————————————————————— 移除筛选 ———————————————————————————

/**
 * 是否包含已移除的记录。默认 `active`（不显示已移除）。
 *
 * ⚠️ 已移除的记录**只能在这里被筛到**：用户端永远看不到它们，
 * 但后台必须能查——「这个人被移除过」是运营要回答的问题，
 * 一份查不到历史的名单等于把移除做成了硬删除。
 */
export type AdminCompanionRemovalFilter = "active" | "removed";

export const ADMIN_COMPANION_REMOVAL_FILTERS: readonly AdminCompanionRemovalFilter[] = [
  "active",
  "removed",
];

export const ADMIN_COMPANION_REMOVAL_FILTER_LABELS: Record<AdminCompanionRemovalFilter, string> = {
  active: "在名单内",
  removed: "已移除",
};

export const DEFAULT_ADMIN_COMPANION_REMOVAL_FILTER: AdminCompanionRemovalFilter = "active";

export const ADMIN_COMPANION_REMOVAL_INVALID_MESSAGE = "筛选条件 removal 只能是 active / removed";

export function isAdminCompanionRemovalFilter(value: string): value is AdminCompanionRemovalFilter {
  return (ADMIN_COMPANION_REMOVAL_FILTERS as readonly string[]).includes(value);
}

export function readAdminCompanionRemovalFilter(
  raw: string | null,
): AdminCompanionRemovalFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_COMPANION_REMOVAL_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_COMPANION_REMOVAL_FILTER;
  return isAdminCompanionRemovalFilter(value) ? value : null;
}

export function normalizeAdminCompanionRemovalFilter(
  raw: string | null,
): AdminCompanionRemovalFilter {
  return readAdminCompanionRemovalFilter(raw) ?? DEFAULT_ADMIN_COMPANION_REMOVAL_FILTER;
}

// ——————————————————————————— 列表查询 ———————————————————————————

export type AdminCompanionListQuery = {
  /** 空串表示不搜索 */
  keyword: string;
  /** 空串表示全部游戏 */
  gameId: string;
  state: AdminCompanionStateFilter;
  removal: AdminCompanionRemovalFilter;
  page: number;
  pageSize: number;
};

export function buildAdminCompanionListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的游戏筛选；空串表示全部游戏 */
  gameId: string;
  state: AdminCompanionStateFilter;
  removal: AdminCompanionRemovalFilter;
}): AdminCompanionListQuery {
  const keyword = input.params.get("keyword");

  return {
    keyword: typeof keyword === "string" ? keyword.trim() : "",
    gameId: input.gameId,
    state: input.state,
    removal: input.removal,
    page: clampPage(input.params.get("page"), ADMIN_COMPANION_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_COMPANION_PAGE_SIZE,
      ADMIN_COMPANION_MAX_PAGE_SIZE,
    ),
  };
}

/** 排序与公开列表**共用同一个函数**：后台看到的顺序就是用户看到的顺序。 */
export const compareCompanionsForAdmin = compareCompanionsForList;

/** 关键词命中规则与公开列表共用：昵称 / 自我介绍 / 服务标签。 */
export const companionMatchesAdminKeyword = companionMatchesKeyword;

// ——————————————————————————— 状态口径 ———————————————————————————

/**
 * 一条护航在后台眼里的状态。**四个取值互斥且有序**，优先级从上到下：
 * 已移除 > 已停用 > 暂不可接单 > 可接单。
 *
 * 页面据此显示文字（`label`）与说明（`description`）——§十一 要求
 * **状态不能只靠颜色表达**，因此每一条记录都必然带一句可读的文字。
 */
export type AdminCompanionStatusKey = "removed" | "disabled" | "unavailable" | "available";

export type AdminCompanionStatus = {
  key: AdminCompanionStatusKey;
  label: string;
  description: string;
};

const COMPANION_STATUS_TEXT: Record<AdminCompanionStatusKey, { label: string; description: string }> =
  {
    removed: { label: "已移除", description: "用户端不可见，历史记录保留" },
    disabled: { label: "已停用", description: "不在公开名单里，直链详情为只读" },
    unavailable: { label: "暂不可接单", description: "在名单里，结算时不可选" },
    available: { label: "可接单", description: "在名单里，结算时可选" },
  };

export function adminCompanionStatus(
  companion: Pick<Companion, "enabled" | "available" | "removedAt">,
): AdminCompanionStatus {
  const key: AdminCompanionStatusKey =
    companion.removedAt !== null
      ? "removed"
      : !companion.enabled
        ? "disabled"
        : !companion.available
          ? "unavailable"
          : "available";

  return { key, ...COMPANION_STATUS_TEXT[key] };
}

/** 状态文字色。颜色令牌集中在 `app/globals.css`，这里只引用，不写死色值。 */
export const ADMIN_COMPANION_STATUS_CLASS: Record<AdminCompanionStatusKey, string> = {
  removed: "text-status-muted",
  disabled: "text-status-danger",
  unavailable: "text-status-pending",
  available: "text-status-success",
};

// ——————————————————————————— 编辑白名单 ———————————————————————————

/** 昵称上限。与用户昵称、入驻申请昵称同为 20，三处口径一致。 */
export const COMPANION_PROFILE_NAME_MAX_LENGTH = 20;
/** 自我介绍上限。与入驻申请的自我介绍同为 300。 */
export const COMPANION_PROFILE_INTRO_MAX_LENGTH = 300;
/** 不可接单原因上限。与入驻申请的联系说明同为 50。 */
export const COMPANION_PROFILE_REASON_MAX_LENGTH = 50;
/** 展示排序的取值范围。 */
export const COMPANION_SORT_ORDER_MIN = 0;
export const COMPANION_SORT_ORDER_MAX = 9999;

/** 头像白名单：与用户资料编辑用的是同一组本地占位图，后台不能填任意地址。 */
export const COMPANION_AVATAR_OPTIONS: readonly string[] = MOCK_AVATAR_OPTIONS;

export const COMPANION_PROFILE_NAME_EMPTY_MESSAGE = "请填写陪玩昵称";
export const COMPANION_PROFILE_NAME_TOO_LONG_MESSAGE = `陪玩昵称不能超过 ${COMPANION_PROFILE_NAME_MAX_LENGTH} 个字符`;
export const COMPANION_PROFILE_AVATAR_INVALID_MESSAGE = "头像只能是白名单里的 Mock 占位图";
export const COMPANION_PROFILE_INTRO_EMPTY_MESSAGE = "请填写自我介绍";
export const COMPANION_PROFILE_INTRO_TOO_LONG_MESSAGE = `自我介绍不能超过 ${COMPANION_PROFILE_INTRO_MAX_LENGTH} 个字符`;
export const COMPANION_PROFILE_GAME_REQUIRED_MESSAGE = "请至少选择一个擅长游戏";
export const COMPANION_PROFILE_GAME_INVALID_MESSAGE = "所选游戏不是有效游戏，请重新选择";
export const COMPANION_PROFILE_REGION_REQUIRED_MESSAGE = "请至少选择一个可服务的大区";
export const COMPANION_PROFILE_REGION_INVALID_MESSAGE = "所选大区不属于已选的游戏，请重新选择";
export const COMPANION_PROFILE_TAG_REQUIRED_MESSAGE = "请至少选择一个服务标签";
export const COMPANION_PROFILE_TAG_INVALID_MESSAGE = "所选服务标签无效，请重新选择";
export const COMPANION_PROFILE_REASON_REQUIRED_MESSAGE = "不可接单时必须填写原因";
export const COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE = `不可接单原因不能超过 ${COMPANION_PROFILE_REASON_MAX_LENGTH} 个字符`;
export const COMPANION_PROFILE_SORT_ORDER_INVALID_MESSAGE = `展示排序只能是 ${COMPANION_SORT_ORDER_MIN} 到 ${COMPANION_SORT_ORDER_MAX} 之间的整数`;

export const COMPANION_PROFILE_FIELD_LABELS = {
  displayName: "陪玩昵称",
  avatarUrl: "头像",
  intro: "自我介绍",
  gameIds: "擅长游戏",
  regions: "可服务大区",
  serviceTags: "服务标签",
  enabled: "启用状态",
  available: "可接单状态",
  unavailableReason: "不可接单原因",
  sortOrder: "展示排序",
} as const;

/** 编辑表单的字段名。页面据此把错误定位到具体输入框（`aria-invalid` / `aria-describedby`）。 */
export type CompanionProfileField = keyof typeof COMPANION_PROFILE_FIELD_LABELS;

/** 各字段的错误；没有错误为 null。 */
export type CompanionProfileFieldErrors = Record<CompanionProfileField, string | null>;

const NO_ERRORS: CompanionProfileFieldErrors = {
  displayName: null,
  avatarUrl: null,
  intro: null,
  gameIds: null,
  regions: null,
  serviceTags: null,
  enabled: null,
  available: null,
  unavailableReason: null,
  sortOrder: null,
};

/** 表单里可以填的原始值（都是字符串，勾选框是布尔）。 */
export type CompanionProfileInput = {
  displayName: string;
  avatarUrl: string;
  intro: string;
  gameIds: readonly string[];
  regions: readonly string[];
  serviceTags: readonly string[];
  enabled: boolean;
  available: boolean;
  unavailableReason: string;
  sortOrder: number;
};

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

function validateName(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: COMPANION_PROFILE_NAME_EMPTY_MESSAGE };
  if (countCharacters(value) > COMPANION_PROFILE_NAME_MAX_LENGTH) {
    return { ok: false, message: COMPANION_PROFILE_NAME_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

function validateIntro(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: COMPANION_PROFILE_INTRO_EMPTY_MESSAGE };
  if (countCharacters(value) > COMPANION_PROFILE_INTRO_MAX_LENGTH) {
    return { ok: false, message: COMPANION_PROFILE_INTRO_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

function validateGames(raw: readonly string[], games: readonly CompanionGameOption[]): FieldResult<string[]> {
  const known = new Set(games.map((game) => game.id));
  const seen = new Set<string>();
  const value: string[] = [];

  for (const item of raw) {
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    if (!known.has(id)) return { ok: false, message: COMPANION_PROFILE_GAME_INVALID_MESSAGE };
    seen.add(id);
    value.push(id);
  }

  if (value.length === 0) return { ok: false, message: COMPANION_PROFILE_GAME_REQUIRED_MESSAGE };
  return { ok: true, value };
}

/**
 * 大区必须属于**所选的某个游戏**。
 *
 * 与入驻申请表单同一条规则：一个「擅长三角洲行动、可服务无畏契约大区」的护航
 * 在结算页是解释不清的——用户选了游戏却看到另一个游戏的大区。
 */
function validateRegions(
  raw: readonly string[],
  gameIds: readonly string[],
  games: readonly CompanionGameOption[],
): FieldResult<string[]> {
  const allowed = new Set(
    games.filter((game) => gameIds.includes(game.id)).flatMap((game) => game.regions),
  );
  const seen = new Set<string>();
  const value: string[] = [];

  for (const item of raw) {
    const region = item.trim();
    if (!region || seen.has(region)) continue;
    if (!allowed.has(region)) return { ok: false, message: COMPANION_PROFILE_REGION_INVALID_MESSAGE };
    seen.add(region);
    value.push(region);
  }

  if (value.length === 0) return { ok: false, message: COMPANION_PROFILE_REGION_REQUIRED_MESSAGE };
  return { ok: true, value };
}

function validateTags(raw: readonly string[]): FieldResult<string[]> {
  const allowed = new Set(COMPANION_SERVICE_TAGS);
  const seen = new Set<string>();
  const value: string[] = [];

  for (const item of raw) {
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    if (!allowed.has(tag)) return { ok: false, message: COMPANION_PROFILE_TAG_INVALID_MESSAGE };
    seen.add(tag);
    value.push(tag);
  }

  if (value.length === 0) return { ok: false, message: COMPANION_PROFILE_TAG_REQUIRED_MESSAGE };
  return { ok: true, value };
}

/**
 * 「不可接单原因」的校验：必填 + 长度上限。
 *
 * 前端（暂停接单的确认框、编辑表单）与服务端（`setAdminCompanionFlags`）**共用这一个函数**。
 * 它存在的原因之一是界面上**没有** `maxLength`：输入框不会替人截断，超长必须能说出
 * 「超了几个字」，而不是让人对着一个突然打不进去的输入框猜。
 */
export function normalizeCompanionReason(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: COMPANION_PROFILE_REASON_REQUIRED_MESSAGE };
  if (countCharacters(value) > COMPANION_PROFILE_REASON_MAX_LENGTH) {
    return { ok: false, message: COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

/**
 * 推导编辑表单各字段的错误。
 *
 * 与入驻申请表单同一套做法：**逐字段给出一条**最终会生效的错误，
 * 页面拿它做 `aria-invalid` / `aria-describedby`，并把第一条出错的字段聚焦过去。
 * 校验顺序即页面上的字段顺序——「第一条错误」因此是「最靠上的那条」。
 */
export function companionProfileFieldErrors(
  input: CompanionProfileInput,
  games: readonly CompanionGameOption[],
): CompanionProfileFieldErrors {
  const name = validateName(input.displayName);
  const intro = validateIntro(input.intro);
  const avatar = COMPANION_AVATAR_OPTIONS.includes(input.avatarUrl.trim())
    ? null
    : COMPANION_PROFILE_AVATAR_INVALID_MESSAGE;
  const selectedGames = validateGames(input.gameIds, games);
  const selectedRegions = selectedGames.ok
    ? validateRegions(input.regions, selectedGames.value, games)
    : ({ ok: false, message: COMPANION_PROFILE_REGION_REQUIRED_MESSAGE } as const);
  const tags = validateTags(input.serviceTags);

  const reason = input.unavailableReason.trim();
  const reasonError = !input.enabled || input.available
    ? null
    : !reason
      ? COMPANION_PROFILE_REASON_REQUIRED_MESSAGE
      : countCharacters(reason) > COMPANION_PROFILE_REASON_MAX_LENGTH
        ? COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE
        : null;

  const sortOrder = Number.isInteger(input.sortOrder)
    ? input.sortOrder < COMPANION_SORT_ORDER_MIN || input.sortOrder > COMPANION_SORT_ORDER_MAX
      ? COMPANION_PROFILE_SORT_ORDER_INVALID_MESSAGE
      : null
    : COMPANION_PROFILE_SORT_ORDER_INVALID_MESSAGE;

  return {
    ...NO_ERRORS,
    displayName: name.ok ? null : name.message,
    avatarUrl: avatar,
    intro: intro.ok ? null : intro.message,
    gameIds: selectedGames.ok ? null : selectedGames.message,
    regions: selectedRegions.ok ? null : selectedRegions.message,
    serviceTags: tags.ok ? null : tags.message,
    unavailableReason: reasonError,
    sortOrder,
  };
}

/** 表单是否有错。页面用它决定「不提交、把第一条错误聚焦过来」。 */
export function hasCompanionProfileError(errors: CompanionProfileFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/** 「第一条错」的字段名，按页面上的字段顺序。全部通过时返回 null。 */
export function firstCompanionProfileErrorField(
  errors: CompanionProfileFieldErrors,
): CompanionProfileField | null {
  for (const field of Object.keys(COMPANION_PROFILE_FIELD_LABELS) as CompanionProfileField[]) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * 原始输入 → 编辑入参。
 *
 * ⚠️ 返回 `null` 表示**校验没过**，调用方必须先 `companionProfileFieldErrors()` 拿到
 * 逐字段的错误再决定怎么办。这里再挡一次，是为了让「忘了先校验」也不可能写进脏数据——
 * 与入驻申请服务「先校验再写入」的顺序一致。
 *
 * 两条归一化规则：
 * - `enabled === false` 强制 `available === false`（停用的记录不可能正在接单）；
 * - 其余情况原样保留，**不替调用方编造原因**。
 */
export function normalizeCompanionProfilePatch(
  input: CompanionProfileInput,
  games: readonly CompanionGameOption[],
): AdminCompanionProfilePatch | null {
  const errors = companionProfileFieldErrors(input, games);
  if (hasCompanionProfileError(errors)) return null;

  const enabled = input.enabled;
  const available = enabled ? input.available : false;

  return {
    displayName: input.displayName.trim(),
    avatarUrl: input.avatarUrl.trim(),
    intro: input.intro.trim(),
    gameIds: [...input.gameIds],
    regions: [...input.regions],
    serviceTags: [...input.serviceTags],
    enabled,
    available,
    unavailableReason: available ? "" : input.unavailableReason.trim(),
    sortOrder: input.sortOrder,
  };
}

/**
 * 这次编辑对应哪一个审计动作。
 *
 * 顺序即优先级：**启用状态的变化优先于可接单状态**——一次停用顺带把
 * `available` 也改成 false，记成「停用护航」比记成「暂停接单」准确得多。
 * 两者都没变就是一次普通的资料编辑。
 */
export function adminCompanionActionFromPatch(
  previous: Pick<Companion, "enabled" | "available">,
  patch: Pick<AdminCompanionProfilePatch, "enabled" | "available">,
): AdminAuditAction {
  if (previous.enabled !== patch.enabled) {
    return patch.enabled ? "companion.enable" : "companion.disable";
  }
  if (previous.available !== patch.available) {
    return patch.available ? "companion.resume" : "companion.pause";
  }
  return "companion.update";
}

/** 这次编辑是否什么都没改。没改就不写数据、也不写审计。 */
export function isCompanionProfileUnchanged(
  previous: Companion,
  patch: AdminCompanionProfilePatch,
): boolean {
  return (
    previous.displayName === patch.displayName &&
    previous.avatarUrl === patch.avatarUrl &&
    previous.intro === patch.intro &&
    sameList(previous.gameIds, patch.gameIds) &&
    sameList(previous.regions, patch.regions) &&
    sameList(previous.serviceTags, patch.serviceTags) &&
    previous.enabled === patch.enabled &&
    previous.available === patch.available &&
    previous.unavailableReason === patch.unavailableReason &&
    previous.sortOrder === patch.sortOrder
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

// ——————————————————————————— 二次确认（§八） ———————————————————————————

/**
 * 五种危险动作的二次确认文案。
 *
 * ⚠️ 二次确认是**界面上的**保障，它挡不住网络重试与并发请求：同一个人在两台设备上
 * 同时点了「停用」，两次请求都会到达服务端。真正的防重是幂等键加服务端的状态判断
 * （§九：不能依赖按钮禁用防重），确认框只负责让人看清后果。
 */
export const ADMIN_COMPANION_CONFIRM_TEXTS = {
  pause: "暂停接单后该护航仍在公开名单与详情页里，但结算时不可选。确定暂停？",
  resume: "恢复接单后该护航可以在结算页被选择。确定恢复？",
  disable: "停用后该护航不再出现在用户端名单与结算页，直链详情变成只读页。确定停用？",
  enable: "启用后该护航重新出现在用户端名单里。确定启用？",
  remove:
    "移除后该护航从用户端完全消失，后台只能用「已移除」筛选查到；" +
    "历史订单、评价与鸡腿记录保留，不会删除。确定移除？",
} as const;

/** 动作按钮的文案。列表与详情共用同一份，不出现两种叫法。 */
export const ADMIN_COMPANION_ACTION_LABELS = {
  pause: "暂停接单",
  resume: "恢复接单",
  disable: "停用",
  enable: "启用",
  remove: "移除",
  save: "保存修改",
} as const;

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const ADMIN_COMPANION_NOT_FOUND_MESSAGE = "护航不存在";
export const ADMIN_COMPANION_REMOVED_MESSAGE = "该护航已移除，不能再编辑或停用";
export const ADMIN_COMPANION_DISABLED_MESSAGE = "该护航已停用，请先启用再操作接单状态";
export const ADMIN_COMPANION_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_COMPANION_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";
/** 资料校验未通过时的兜底提示（正常情况下字段级错误已经由表单给出）。 */
export const ADMIN_COMPANION_PROFILE_INVALID_MESSAGE = "护航资料校验未通过，请检查表单";

// ——————————————————————————— DTO 转换 ———————————————————————————

function toGames(
  gameIds: readonly string[],
  gameNameById: Readonly<Record<string, string>>,
): { id: string; name: string }[] {
  return gameIds.map((id) => ({ id, name: gameNameById[id] ?? id }));
}

/**
 * 内部实体 → 管理端列表项 / 详情。
 *
 * ⚠️ **显式挑字段**：`reviews`（评价正文数组）不在管理端 DTO 里——后台要看的是
 * 「有几条评价」，不是每一条写了什么；评价内容的处置属于后续的投诉/评价模块。
 * 与公开 DTO 一样，这里不是 `{ ...companion }` 再删几个，新增内部字段默认不外流。
 */
export function toAdminCompanionListItem(
  companion: Companion,
  gameNameById: Readonly<Record<string, string>>,
): AdminCompanionListItem {
  return {
    id: companion.id,
    displayName: companion.displayName,
    avatarUrl: companion.avatarUrl,
    intro: companion.intro,
    games: toGames(companion.gameIds, gameNameById),
    regions: [...companion.regions],
    serviceTags: [...companion.serviceTags],
    enabled: companion.enabled,
    available: companion.available,
    unavailableReason: companion.unavailableReason,
    sortOrder: companion.sortOrder,
    removedAt: companion.removedAt,
    linkedUserId: companion.userId,
    applicationId: companion.applicationId,
    rating: companion.rating,
    completedOrderCount: companion.completedOrderCount,
    reviewCount: companion.reviewCount,
    tipsCount: companion.tipsCount,
  };
}
