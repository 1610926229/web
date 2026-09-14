import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_CATEGORY_LIST_NOTICE,
  ADMIN_CATEGORY_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_CATEGORY_NOT_FOUND_MESSAGE,
  ADMIN_CATEGORY_OPERATION_CONFLICT_MESSAGE,
  ADMIN_CATEGORY_PROFILE_INVALID_MESSAGE,
  ADMIN_CATEGORY_REMOVED_MESSAGE,
  CATEGORY_DUPLICATE_NAME_MESSAGE,
  adminCategoryHasProductsMessage,
  buildAdminCategoryListQuery,
  categoryProfileFieldErrors,
  countAdminCategoryStates,
  hasCategoryProfileError,
  normalizeCategoryProfilePatch,
  readAdminCategoryGameId,
  toAdminCategoryListItem,
  toAdminCategoryWriteResult,
  type AdminCategoryListQuery,
  type CategoryGameOption,
  type CategoryProfileFieldErrors,
  type CategoryProfileInput,
} from "@/lib/constants/adminCategories";
import {
  ADMIN_CATALOG_REMOVAL_INVALID_MESSAGE,
  ADMIN_ENABLED_INVALID_MESSAGE,
  readAdminCatalogRemovalFilter,
  readAdminEnabledFilter,
} from "@/lib/constants/adminCatalog";
import {
  IDEMPOTENCY_KEY_PATTERN,
  readBoolean,
  readIdempotencyKey,
  readInteger,
  readTrimmedString,
} from "@/lib/constants/writes";
import { getCatalogRepository } from "@/lib/data/catalogRepository";
import {
  createCategory,
  removeCategory,
  setCategoryEnabled,
  updateCategory,
  type AdminCatalogWriteFailure,
  type AdminWriteContext,
  type CategoryDraft,
} from "@/lib/data/adminCatalogTransaction";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminCategoryListItem,
  AdminCategoryListData,
  AdminCategoryWriteResult,
} from "@/lib/types/catalog";

/**
 * 管理端「类目管理」服务 —— 列表、详情与四种写操作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处。
 *
 * 这一层负责三件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段就是 `AdminCategoryProfilePatch` 那些）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 生成 DTO —— 仓储实体不会流到浏览器。
 *
 * 业务规则不在这里：字段取值、游戏是否真实存在、状态口径在
 * `lib/constants/adminCategories.ts`；**重名与「有商品不能删」的最终判定**在
 * `lib/data/adminCatalogTransaction.ts` 的原子区段里——它们必须与写入同一区间，
 * 否则两个并发请求会各自读到「没有」然后都写进去。
 *
 * ⚠️ **数据源只有一份**：本文件读的类目与用户端分类导航读的是同一个仓储
 * （`getCatalogRepository()`），因此这里的编辑会立刻反映到前台，不需要任何同步动作。
 */

export type { AdminCategoryListData };

/**
 * 解析列表查询条件。约定与其它管理列表一致：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 */
export async function resolveAdminCategoryListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminCategoryListQuery> {
  const knownGameIds = (await getCatalogRepository().listGames()).map((game) => game.id);

  const removal = readAdminCatalogRemovalFilter(params.get("removal"));
  const enabled = readAdminEnabledFilter(params.get("enabled"));
  const gameId = readAdminCategoryGameId(params.get("gameId"), knownGameIds);

  if (strict) {
    if (removal === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_CATALOG_REMOVAL_INVALID_MESSAGE, 400);
    }
    if (enabled === null) throw new ApiError("BAD_REQUEST", ADMIN_ENABLED_INVALID_MESSAGE, 400);
    if (gameId === null) throw new ApiError("BAD_REQUEST", "筛选条件 gameId 不是有效的游戏", 400);
  }

  return buildAdminCategoryListQuery({
    params,
    gameId: gameId ?? "",
    enabled: enabled ?? "",
    removal: removal ?? "active",
  });
}

/** 一次把「游戏 id → 名称」与「筛选栏选项」都取回来，两处用的是同一份游戏数据。 */
async function gameContext(): Promise<{
  names: Record<string, string>;
  options: CategoryGameOption[];
}> {
  const games = await getCatalogRepository().listGames();
  return {
    names: Object.fromEntries(games.map((game) => [game.id, game.name])),
    options: games.map((game) => ({ id: game.id, name: game.name })),
  };
}

/**
 * 管理端类目列表。
 *
 * 走的是仓储里**唯一**的那份类目表（含停用与已移除），因此「后台看到全部、
 * 用户端只看到启用且未移除的」这件事由数据层与 `lib/constants/catalog.ts` 保证，
 * 页面不自己过滤。
 */
export async function queryAdminCategoryList(
  query: AdminCategoryListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCategoryListData> {
  return withMockDebug(params, surface, async () => {
    const catalog = getCatalogRepository();
    const [{ names, options }, all] = await Promise.all([
      gameContext(),
      catalog.listCategories(),
    ]);

    // 角标口径覆盖**全部**记录（含已移除）：已移除是类目的一个终态，
    // 「有多少条被移除过」是运营要看的数字，但已移除的**不能**混进 enabled / disabled 里
    // ——那两个角标点进去看到的是「使用中」的记录。
    const counts = countAdminCategoryStates(all);

    if (mockEmptyApplies(params, "categories")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        games: options,
        counts,
        notice: ADMIN_CATEGORY_LIST_NOTICE,
      };
    }

    const rows = await catalog.queryCategoriesForAdmin({
      keyword: query.keyword,
      gameId: query.gameId,
      enabled: query.enabled,
      removal: query.removal,
    });

    const start = (query.page - 1) * query.pageSize;
    const pageRows = rows.slice(start, start + query.pageSize);

    // 每行都要一个「下面还有几件未移除的商品」。**串行取会慢一倍**，
    // 因此一次并发取回来；数量就是本页条数（最多 50），不会把仓储压垮。
    const productCounts = await Promise.all(
      pageRows.map((record) => catalog.countProductsInCategory(record.id)),
    );

    const items: AdminCategoryListItem[] = pageRows.map((record, index) =>
      toAdminCategoryListItem(record, names, productCounts[index] ?? 0),
    );

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: rows.length,
      hasMore: start + items.length < rows.length,
      games: options,
      counts,
      notice: ADMIN_CATEGORY_LIST_NOTICE,
    };
  });
}

/**
 * 管理端类目详情。
 *
 * ⚠️ **已移除的类目仍然返回详情**：后台要能查到「这条类目被移除过」，
 * 返回 404 等于把移除变成了「记录消失」，那正是软删除要避免的事。
 */
export async function getAdminCategoryDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCategoryListItem | null> {
  return withMockDebug(params, surface, async () => {
    const catalog = getCatalogRepository();
    const [record, { names }, productCount] = await Promise.all([
      catalog.findCategoryById(id),
      gameContext(),
      catalog.countProductsInCategory(id),
    ]);

    return record ? toAdminCategoryListItem(record, names, productCount) : null;
  });
}

/** 编辑表单要用的游戏选项。类目必须挂在真实存在的游戏上，因此这份映射是前提。 */
export async function getAdminCategoryFormOptions(): Promise<{ games: CategoryGameOption[] }> {
  const { options } = await gameContext();
  return { games: options };
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————

function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_CATEGORY_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return {
    actorId: adminId,
    actorRole: "admin",
    actorName: null,
    operationId,
    at: new Date().toISOString(),
  };
}

/**
 * 从请求体里读出一份完整的类目输入。
 *
 * ⚠️ **入参就是白名单**：`createdAt`、`updatedAt`、`removedAt`、`id` 在这里
 * **没有读取的位置**，客户端多传一个字段也不会有任何效果。这不是「忘了校验」，
 * 而是类型上就没有入口（§九：客户端伪造 ID、状态、时间必须被忽略）。
 */
function readCategoryInput(body: Record<string, unknown>): CategoryProfileInput {
  return {
    gameId: readTrimmedString(body, "gameId"),
    name: readTrimmedString(body, "name"),
    // 缺省用 NaN 而不是 0：NaN 会让「展示排序只能是…」的校验报错，
    // 静默当成 0 等于把一个没传的字段变成一个合法值写进记录
    sortOrder: readInteger(body, "sortOrder", Number.NaN),
    enabled: readBoolean(body, "enabled", true),
  };
}

/** 逐字段校验 → 入参；任何一处不过就抛 400，message 是**第一条**错误。 */
function validateCategory(
  input: CategoryProfileInput,
  games: readonly CategoryGameOption[],
): CategoryDraft {
  const errors: CategoryProfileFieldErrors = categoryProfileFieldErrors(input, games);
  if (hasCategoryProfileError(errors)) {
    throw new ApiError("BAD_REQUEST", firstErrorMessage(errors), 400);
  }

  const patch = normalizeCategoryProfilePatch(input, games);
  if (!patch) throw new ApiError("BAD_REQUEST", ADMIN_CATEGORY_PROFILE_INVALID_MESSAGE, 400);
  return patch;
}

function firstErrorMessage(errors: Record<string, string | null>): string {
  for (const message of Object.values(errors)) {
    if (message) return message;
  }
  return ADMIN_CATEGORY_PROFILE_INVALID_MESSAGE;
}

/**
 * 伪事务的失败 → 接口错误。
 *
 * 六种失败各有各的处置，合并成一句「操作失败」会让调用方不知道该刷新、
 * 该改名字还是该先处理商品。
 */
function toApiFailure(failure: AdminCatalogWriteFailure): ApiError {
  switch (failure.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_CATEGORY_NOT_FOUND_MESSAGE, 404);
    case "removed":
      return new ApiError("BAD_REQUEST", ADMIN_CATEGORY_REMOVED_MESSAGE, 400);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_CATEGORY_OPERATION_CONFLICT_MESSAGE, 400);
    case "duplicate-name":
      // 这句话与表单的字段级错误**同源**（同一个常量）：表单据此把它挂到「类目名称」上，
      // 运营看到的就是「名称这一栏错了」，而不是一条不知道改哪里的横幅
      return new ApiError("BAD_REQUEST", CATEGORY_DUPLICATE_NAME_MESSAGE, 400);
    case "has-products":
      return new ApiError("BAD_REQUEST", adminCategoryHasProductsMessage(failure.count), 400);
    default:
      // 规格相关的三种失败属于商品写操作，类目这条路径上出现只可能是接线错了，
      // 此时回一句通用的「校验未通过」，不编一个「规格不属于该商品」的说法
      return new ApiError("BAD_REQUEST", ADMIN_CATEGORY_PROFILE_INVALID_MESSAGE, 400);
  }
}

type TransactionOutcome = Awaited<ReturnType<typeof createCategory>>;

/** 伪事务结果 → 接口结果。成功只回状态字段，界面据此就地更新那一行。 */
function toWriteResult(outcome: TransactionOutcome): AdminCategoryWriteResult {
  if (outcome.kind !== "ok") throw toApiFailure(outcome);

  const { updated } = outcome.value;
  return toAdminCategoryWriteResult(updated.id, updated, outcome.changed);
}

// ——————————————————————————— 四种写操作 ———————————————————————————

/**
 * 新建类目。
 *
 * 返回 400 时 message 可能就是「同一游戏内已有同名类目」——那句话的判定在服务端，
 * 客户端手上的类目列表可能已经过期，因此**不**在本地给一个虚假的「没问题」。
 */
export async function createAdminCategory(
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCategoryWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const games = (await getAdminCategoryFormOptions()).games;
  const input = validateCategory(readCategoryInput(body), games);

  return toWriteResult(await createCategory(input, writeContext(adminId, operationId)));
}

/** 编辑类目（名称 / 所属游戏 / 排序 / 启用状态，一次保存）。 */
export async function updateAdminCategory(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCategoryWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const games = (await getAdminCategoryFormOptions()).games;
  const input = validateCategory(readCategoryInput(body), games);

  return toWriteResult(await updateCategory(id, input, writeContext(adminId, operationId)));
}

/**
 * 启用 / 停用类目（窄写入）。
 *
 * ⚠️ 与 `updateAdminCategory()` 分开：列表上的开关只应当改启用状态，
 * 而不是「读出整条记录、拼一个完整 patch 再写回去」——后者会在两位管理员
 * 同时操作时，用后写的那次把另一位刚改好的名称覆盖回旧值。
 */
export async function setAdminCategoryEnabled(
  id: string,
  enabled: boolean,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCategoryWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await setCategoryEnabled(id, enabled, writeContext(adminId, operationId)));
}

/**
 * 移除类目（软删除）。
 *
 * ⚠️ 类目下还有未移除的商品时会被服务端拒绝，且**不级联删除商品**：
 * 一次点击静默下架一批还在卖的东西是不可接受的。
 */
export async function removeAdminCategory(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCategoryWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await removeCategory(id, writeContext(adminId, operationId)));
}
