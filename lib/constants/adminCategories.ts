import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type {
  AdminCategoryListItem,
  AdminCategoryProfilePatch,
  AdminCategoryWriteResult,
  CategoryRecord,
} from "@/lib/types/catalog";
import { countCharacters } from "@/lib/utils/text";
import {
  readAdminCatalogId,
  readAdminCatalogKeyword,
  readAdminCatalogPaging,
  type AdminCatalogRemovalFilter,
} from "./adminCatalog";

/**
 * 管理端「类目管理」的字段规则、状态口径与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型、`./adminCatalog` 与 `lib/utils/text.ts` 外没有运行时依赖，
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 四组规则写在这里，它们都是 §类目规则 的直接落点：
 *
 * 1. **编辑白名单**：`normalizeCategoryProfilePatch()` 是「客户端能改什么」的唯一实现。
 *    `removedAt`（移除）与 `createdAt` **不在入参类型里**，因此不存在「忘了校验」这条路径：
 *    一次普通保存永远无法把一条已移除的类目改回未移除。要让人回来必须走新流程。
 * 2. **游戏必须真实存在**：`gameId` 必须命中游戏目录里的一个 id。类目挂在虚构的游戏上，
 *    在用户端就是一个永远不出现的孤立记录。
 * 3. **同一游戏内不能重名**：客户端只能检查自己看得见的那一份；真正的判定在
 *    `lib/data/adminCatalogTransaction.ts` 的原子区段里（两个同名创建请求同时到达时，
 *    「先查有没有、再创建」中间隔着 `await`，两边都会查到「没有」）。
 *    本文件提供的是**同一条口径**的文案，服务端拒绝时回的也是这一句。
 * 4. **危险操作都要二次确认**：确认文案在这里，但确认框**不是**防重手段——
 *    真正的防重是服务端的幂等键与状态判断（§九：不能依赖按钮禁用防重）。
 *
 * ⚠️ 本文件与商品共用的部分（removal / keyword / 分页 / id 筛选）在 `./adminCatalog`。
 * 类目特有的一点是「没有上下架，只有启用 / 停用」，因此它用的是 `enabled` 而不是 `status`。
 */

export const ADMIN_CATEGORY_LIST_TITLE = "类目管理";
export const ADMIN_CATEGORY_NEW_TITLE = "新建类目";
export const ADMIN_CATEGORY_DETAIL_TITLE = "类目详情";
export const ADMIN_CATEGORY_EDIT_TITLE = "编辑类目";

/**
 * 列表页顶部的一句话。
 *
 * ⚠️ 这不是装饰文案：后台最容易犯的错是以为「这里的改动只影响后台」，
 * 而实际上首页、分类页、商品详情与结算页读的都是这一份数据。
 */
export const ADMIN_CATEGORY_LIST_NOTICE =
  "这里的改动会立即影响用户端的分类导航与商品归属——后台与用户端读的是同一份数据。";

export const ADMIN_CATEGORY_EMPTY_MESSAGE = "当前筛选下没有类目。";
export const ADMIN_CATEGORY_REMOVED_EMPTY_MESSAGE = "没有已移除的类目。";

/** 列表默认每页条数。类目总数不多，一页 10 条足够。 */
export const ADMIN_CATEGORY_PAGE_SIZE = 10;

/** 概览卡片的角标口径说明。 */
export const ADMIN_CATEGORY_COUNT_LABELS = {
  all: "全部类目",
  enabled: "已启用",
  disabled: "已停用",
  removed: "已移除",
} as const;

// ——————————————————————————— 字段规则 ———————————————————————————

/**
 * 类目名称上限。
 *
 * 用户端左侧竖栏是一列窄条，名称长了会折行把整列撑变形。12 个字足够写出
 * 「开业特惠」「段位提升」「娱乐陪玩」这类名字，同时留出余量。
 */
export const CATEGORY_NAME_MAX_LENGTH = 12;

/** 展示排序的取值范围。与护航的排序同一个区间，运营不必记两套数。 */
export const CATEGORY_SORT_ORDER_MIN = 0;
export const CATEGORY_SORT_ORDER_MAX = 9999;

export const CATEGORY_NAME_EMPTY_MESSAGE = "请填写类目名称";
export const CATEGORY_NAME_TOO_LONG_MESSAGE = `类目名称不能超过 ${CATEGORY_NAME_MAX_LENGTH} 个字符`;
export const CATEGORY_GAME_REQUIRED_MESSAGE = "请选择所属游戏";
export const CATEGORY_GAME_INVALID_MESSAGE = "所属游戏不是有效游戏，请重新选择";
export const CATEGORY_SORT_ORDER_INVALID_MESSAGE = `展示排序只能是 ${CATEGORY_SORT_ORDER_MIN} 到 ${CATEGORY_SORT_ORDER_MAX} 之间的整数`;
/**
 * 同一游戏内重名的提示。
 *
 * ⚠️ 这一句**服务端与客户端共用**：服务端拒绝时把这句话放进 400 的 message，
 * 表单据此把它挂到「类目名称」上（见 `AdminCategoryForm`），
 * 因此运营看到的是「名称这一栏错了」，而不是一条不知道改哪里的横幅。
 */
export const CATEGORY_DUPLICATE_NAME_MESSAGE = "同一游戏内已有同名类目";

export const CATEGORY_FIELD_LABELS = {
  gameId: "所属游戏",
  name: "类目名称",
  sortOrder: "展示排序",
  enabled: "启用状态",
} as const;

/** 编辑表单的字段名。页面据此把错误定位到具体输入框（`aria-invalid` / `aria-describedby`）。 */
export type CategoryProfileField = keyof typeof CATEGORY_FIELD_LABELS;

/** 各字段的错误；没有错误为 null。 */
export type CategoryProfileFieldErrors = Record<CategoryProfileField, string | null>;

const NO_ERRORS: CategoryProfileFieldErrors = {
  gameId: null,
  name: null,
  sortOrder: null,
  enabled: null,
};

/** 表单里可以填的原始值（文本都是字符串，勾选框是布尔）。 */
export type CategoryProfileInput = {
  gameId: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
};

/** 游戏选项：校验只需要 id，展示需要 name。 */
export type CategoryGameOption = { id: string; name: string };

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

function validateName(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: CATEGORY_NAME_EMPTY_MESSAGE };
  if (countCharacters(value) > CATEGORY_NAME_MAX_LENGTH) {
    return { ok: false, message: CATEGORY_NAME_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

function validateGame(raw: string, games: readonly CategoryGameOption[]): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: CATEGORY_GAME_REQUIRED_MESSAGE };
  if (!games.some((game) => game.id === value)) {
    return { ok: false, message: CATEGORY_GAME_INVALID_MESSAGE };
  }
  return { ok: true, value };
}

function validateSortOrder(value: number): FieldResult<number> {
  if (!Number.isInteger(value)) {
    return { ok: false, message: CATEGORY_SORT_ORDER_INVALID_MESSAGE };
  }
  if (value < CATEGORY_SORT_ORDER_MIN || value > CATEGORY_SORT_ORDER_MAX) {
    return { ok: false, message: CATEGORY_SORT_ORDER_INVALID_MESSAGE };
  }
  return { ok: true, value };
}

/**
 * 推导编辑表单各字段的错误。
 *
 * 与入驻申请、护航编辑同一套做法：**逐字段给出一条**最终会生效的错误，
 * 页面拿它做 `aria-invalid` / `aria-describedby`，并把第一条出错的字段聚焦过去。
 * 校验顺序即页面上的字段顺序——「第一条错误」因此是「最靠上的那条」。
 *
 * ⚠️ 这里**不检查重名**：重名要跟同游戏下的其它类目比，而客户端手上那份列表
 * 可能已经过期。把它放在这里会给出「本地看着没问题、提交后被拒」的假保证。
 */
export function categoryProfileFieldErrors(
  input: CategoryProfileInput,
  games: readonly CategoryGameOption[],
): CategoryProfileFieldErrors {
  const game = validateGame(input.gameId, games);
  const name = validateName(input.name);
  const sortOrder = validateSortOrder(input.sortOrder);

  return {
    ...NO_ERRORS,
    gameId: game.ok ? null : game.message,
    name: name.ok ? null : name.message,
    sortOrder: sortOrder.ok ? null : sortOrder.message,
  };
}

/** 表单是否有错。页面用它决定「不提交、把第一条错误聚焦过来」。 */
export function hasCategoryProfileError(errors: CategoryProfileFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/** 「第一条错」的字段名，按页面上的字段顺序。全部通过时返回 null。 */
export function firstCategoryProfileErrorField(
  errors: CategoryProfileFieldErrors,
): CategoryProfileField | null {
  for (const field of Object.keys(CATEGORY_FIELD_LABELS) as CategoryProfileField[]) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * 原始输入 → 编辑入参（**服务端写操作的唯一入口形状**）。
 *
 * ⚠️ 返回 `null` 表示**校验没过**，调用方必须先 `categoryProfileFieldErrors()` 拿到
 * 逐字段的错误再决定怎么办。这里再挡一次，是为了让「忘了先校验」也不可能写进脏数据——
 * 与入驻申请、护航编辑「先校验再写入」的顺序一致。
 */
export function normalizeCategoryProfilePatch(
  input: CategoryProfileInput,
  games: readonly CategoryGameOption[],
): AdminCategoryProfilePatch | null {
  const errors = categoryProfileFieldErrors(input, games);
  if (hasCategoryProfileError(errors)) return null;

  return {
    gameId: input.gameId.trim(),
    name: input.name.trim(),
    sortOrder: input.sortOrder,
    enabled: input.enabled,
  };
}

/**
 * 这次编辑对应哪一个审计动作。
 *
 * 启用状态变了就记「启用 / 停用类目」，否则记「编辑类目」。
 * 「停用」既可能来自列表上的开关，也可能来自编辑表单里把勾去掉，
 * 两者记的都是同一件事——审计的粒度是「发生了一次什么变更」，不是「调了哪个接口」。
 */
export function adminCategoryActionFromPatch(
  previous: Pick<CategoryRecord, "enabled">,
  patch: Pick<AdminCategoryProfilePatch, "enabled">,
): AdminAuditAction {
  if (previous.enabled !== patch.enabled) {
    return patch.enabled ? "category.enable" : "category.disable";
  }
  return "category.update";
}

/** 这次编辑是否什么都没改。没改就不写数据、也不写审计。 */
export function isCategoryProfileUnchanged(
  previous: CategoryRecord,
  patch: AdminCategoryProfilePatch,
): boolean {
  return (
    previous.gameId === patch.gameId &&
    previous.name === patch.name &&
    previous.sortOrder === patch.sortOrder &&
    previous.enabled === patch.enabled
  );
}

// ——————————————————————————— 状态口径 ———————————————————————————

/**
 * 一条类目在后台眼里的状态。**三个取值互斥且有序**，优先级从上到下：
 * 已移除 > 已停用 > 已启用。
 *
 * §十一 要求**状态不能只靠颜色表达**，因此每一条记录都必然带一句可读的文字。
 */
export type AdminCategoryStatusKey = "removed" | "disabled" | "enabled";

export type AdminCategoryStatus = {
  key: AdminCategoryStatusKey;
  label: string;
  description: string;
};

const CATEGORY_STATUS_TEXT: Record<AdminCategoryStatusKey, { label: string; description: string }> =
  {
    removed: { label: "已移除", description: "用户端不可见，商品归属仍可追溯" },
    disabled: { label: "已停用", description: "用户端导航里没有它，也不能用于商品归属" },
    enabled: { label: "已启用", description: "在用户端导航里，可用于商品归属" },
  };

export function adminCategoryStatus(
  record: Pick<CategoryRecord, "enabled" | "removedAt">,
): AdminCategoryStatus {
  const key: AdminCategoryStatusKey =
    record.removedAt !== null ? "removed" : record.enabled ? "enabled" : "disabled";

  return { key, ...CATEGORY_STATUS_TEXT[key] };
}

/**
 * 列表角标：全部 / 已启用 / 已停用 / 已移除。
 *
 * ⚠️ 四个数**加起来等于记录总数**（`all` 也含已移除）：
 * 「已启用 / 已停用」只数**未移除**的记录——已移除是类目的一个终态，
 * 它既不是启用也不是停用；把已移除混进「已停用」，点进去会看到两个不同的集合。
 */
export function countAdminCategoryStates(
  records: readonly Pick<CategoryRecord, "enabled" | "removedAt">[],
): { all: number; enabled: number; disabled: number; removed: number } {
  let enabled = 0;
  let disabled = 0;
  let removed = 0;

  for (const record of records) {
    if (record.removedAt !== null) {
      removed += 1;
      continue;
    }
    if (record.enabled) enabled += 1;
    else disabled += 1;
  }

  return { all: records.length, enabled, disabled, removed };
}

// ——————————————————————————— 列表查询 ———————————————————————————

export type AdminCategoryListQuery = {
  /** 空串表示不搜索 */
  keyword: string;
  /** 空串表示全部游戏 */
  gameId: string;
  enabled: "" | "enabled" | "disabled";
  removal: AdminCatalogRemovalFilter;
  page: number;
  pageSize: number;
};

export function buildAdminCategoryListQuery(input: {
  params: URLSearchParams;
  gameId: string;
  enabled: "" | "enabled" | "disabled";
  removal: AdminCatalogRemovalFilter;
}): AdminCategoryListQuery {
  const { page, pageSize } = readAdminCatalogPaging(input.params, ADMIN_CATEGORY_PAGE_SIZE);

  return {
    keyword: readAdminCatalogKeyword(input.params.get("keyword")),
    gameId: input.gameId,
    enabled: input.enabled,
    removal: input.removal,
    page,
    pageSize,
  };
}

/** 游戏 id 的读取规则与商品筛选共用（`./adminCatalog`），这里给一个好读的名字。 */
export const readAdminCategoryGameId = readAdminCatalogId;

// ——————————————————————————— 二次确认（§八） ———————————————————————————

/**
 * 三种危险动作的二次确认文案。
 *
 * ⚠️ 二次确认是**界面上的**保障，它挡不住网络重试与并发请求。真正的防重是
 * 幂等键加服务端的状态判断（§九：不能依赖按钮禁用防重），确认框只负责让人看清后果。
 */
export const ADMIN_CATEGORY_CONFIRM_TEXTS = {
  disable:
    "停用后该类目不再出现在用户端导航里，也不能再用于新建或编辑商品的归属；" +
    "它下面的商品不会被下架，但用户端已经没有入口能走到它们。确定停用？",
  enable: "启用后该类目重新出现在用户端导航里，并可以被选为商品归属。确定启用？",
  remove:
    "移除后该类目从用户端完全消失，后台只能用「使用中 / 已移除」筛选切换查看；" +
    "类目下必须**没有未移除的商品**才能移除，且不会连带删除任何商品。确定移除？",
} as const;

/** 动作按钮的文案。列表与详情共用同一份，不出现两种叫法。 */
export const ADMIN_CATEGORY_ACTION_LABELS = {
  disable: "停用",
  enable: "启用",
  remove: "移除",
  save: "保存修改",
  create: "新建类目",
} as const;

// ——————————————————————————— 服务端提示 ———————————————————————————

export const ADMIN_CATEGORY_NOT_FOUND_MESSAGE = "类目不存在";
export const ADMIN_CATEGORY_REMOVED_MESSAGE = "该类目已移除，不能再编辑或停用";
export const ADMIN_CATEGORY_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_CATEGORY_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";
/** 字段校验未通过时的兜底提示（正常情况下字段级错误已经由表单给出）。 */
export const ADMIN_CATEGORY_PROFILE_INVALID_MESSAGE = "类目资料校验未通过，请检查表单";

/**
 * 类目下还有未移除的商品时的提示。
 *
 * ⚠️ 带上条数，而且**条数是服务端在原子区段里现数的**：列表页上的数字是渲染那一刻的，
 * 点删除的时候可能已经多了一件商品。这里的数字才是拒绝的理由本身。
 */
export function adminCategoryHasProductsMessage(count: number): string {
  return `该类目下还有 ${count} 件未移除的商品，请先处理这些商品再移除类目`;
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/**
 * 内部实体 → 管理端列表项 / 详情。
 *
 * ⚠️ **显式挑字段**：不是 `{ ...record }` 再删几个，实体新增字段时默认不外流。
 * `productCount` 由调用方传入（仓储是异步的，DTO 转换保持纯函数，
 * 这样它才能被客户端组件引用、被 node 直接加载测试）。
 */
export function toAdminCategoryListItem(
  record: CategoryRecord,
  gameNameById: Readonly<Record<string, string>>,
  productCount: number,
): AdminCategoryListItem {
  return {
    id: record.id,
    gameId: record.gameId,
    gameName: gameNameById[record.gameId] ?? record.gameId,
    name: record.name,
    sortOrder: record.sortOrder,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    removedAt: record.removedAt,
    productCount,
  };
}

/** 写操作的返回。界面据此就地更新那一行，不必为了刷新一个开关重拉整页。 */
export function toAdminCategoryWriteResult(
  categoryId: string,
  updated: Pick<CategoryRecord, "enabled" | "removedAt">,
  changed: boolean,
): AdminCategoryWriteResult {
  return { categoryId, enabled: updated.enabled, removedAt: updated.removedAt, changed };
}
