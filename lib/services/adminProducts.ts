import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_CATALOG_REMOVAL_INVALID_MESSAGE,
  ADMIN_RECOMMENDED_INVALID_MESSAGE,
  ADMIN_STATUS_INVALID_MESSAGE,
  readAdminCatalogRemovalFilter,
  readAdminRecommendedFilter,
  readAdminStatusFilter,
} from "@/lib/constants/adminCatalog";
import {
  ADMIN_PRODUCT_DUPLICATE_SPEC_ID_MESSAGE,
  ADMIN_PRODUCT_LIST_NOTICE,
  ADMIN_PRODUCT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_PRODUCT_NOT_FOUND_MESSAGE,
  ADMIN_PRODUCT_OPERATION_CONFLICT_MESSAGE,
  ADMIN_PRODUCT_PROFILE_INVALID_MESSAGE,
  ADMIN_PRODUCT_REMOVED_MESSAGE,
  ADMIN_PRODUCT_UNKNOWN_SPEC_MESSAGE,
  PRODUCT_CATEGORY_INVALID_MESSAGE,
  PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE,
  PRODUCT_COVER_OPTIONS,
  PRODUCT_DETAIL_IMAGE_OPTIONS,
  PRODUCT_GAME_INVALID_MESSAGE,
  PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE,
  SPEC_PRICE_INVALID_MESSAGE,
  SPEC_SORT_ORDER_INVALID_MESSAGE,
  buildAdminProductListQuery,
  countAdminProductStates,
  firstProductProfileErrorField,
  hasProductProfileError,
  normalizeProductProfilePatch,
  productProfileFieldErrors,
  readAdminProductCategoryId,
  readAdminProductGameId,
  toAdminProductListItem,
  toAdminProductWriteResult,
  toProductDraft,
  type AdminProductListQuery,
  type ProductCategoryOption,
  type ProductGameOption,
  type ProductProfileInput,
} from "@/lib/constants/adminProducts";
import {
  IDEMPOTENCY_KEY_PATTERN,
  readBoolean,
  readIdempotencyKey,
  readInteger,
  readStringArray,
  readTrimmedString,
} from "@/lib/constants/writes";
import { getCatalogRepository } from "@/lib/data/catalogRepository";
import {
  createProduct,
  removeProduct,
  setProductStatus,
  updateProduct,
  type AdminCatalogWriteFailure,
  type AdminWriteContext,
  type ProductDraft,
} from "@/lib/data/adminCatalogTransaction";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { ProductSpecInput, ProductStatus } from "@/lib/types/product";
import type {
  AdminProductFormOptions,
  AdminProductListItem,
  AdminProductListData,
  AdminProductWriteResult,
} from "@/lib/types/product";

/**
 * 管理端「商品管理」服务 —— 列表、详情、表单选项与六种写操作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处。
 *
 * 这一层负责四件事：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段就是 `ProductProfilePatch` 那些）；
 * 2. 把原生请求体里的规格行**严格转成整数分**（`lib/constants/adminProducts.ts`）；
 * 3. 把伪事务的失败翻译成明确的接口错误；
 * 4. 生成 DTO —— 仓储实体不会流到浏览器。
 *
 * 业务规则的最终判定在 `lib/data/adminCatalogTransaction.ts` 的原子区段里：
 * 「类目必须属于所选游戏且启用未移除」「上架至少一个有效规格」「规格 id 不能伪造」。
 * 服务层也查一遍，是为了给表单**字段级**的错误；但两次检查里只有原子区段里那次
 * 挡得住并发——服务层查完与写入之间隔着 `await`。
 *
 * ⚠️ **数据源只有一份**：本文件读的商品与首页 / 分类页 / 商品详情 / 结算页
 * 读的是同一个仓储（`getCatalogRepository()`），因此这里的编辑会立刻反映到前台。
 * 历史订单读的是下单快照，不受任何影响。
 */

export type { AdminProductListData };

/**
 * 解析列表查询条件。约定与其它管理列表一致：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 */
export async function resolveAdminProductListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminProductListQuery> {
  const catalog = getCatalogRepository();
  const [games, categories] = await Promise.all([catalog.listGames(), catalog.listCategories()]);

  const status = readAdminStatusFilter(params.get("status"));
  const recommended = readAdminRecommendedFilter(params.get("recommended"));
  const removal = readAdminCatalogRemovalFilter(params.get("removal"));
  // 类目 id **不做存在性校验**：一个不存在的类目 id 筛出 0 条，
  // 这正是「按这个类目筛」的正确结果，而游戏 id 不同——它是导航的一部分，
  // 一个不存在的游戏会让筛选栏整个对不上（见 `./adminCatalog` 里两处注释）
  const gameId = readAdminProductGameId(
    params.get("gameId"),
    games.map((game) => game.id),
  );
  const categoryId = readAdminProductCategoryId(
    params.get("categoryId"),
    categories.map((category) => category.id),
  );

  if (strict) {
    if (status === null) throw new ApiError("BAD_REQUEST", ADMIN_STATUS_INVALID_MESSAGE, 400);
    if (recommended === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_RECOMMENDED_INVALID_MESSAGE, 400);
    }
    if (removal === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_CATALOG_REMOVAL_INVALID_MESSAGE, 400);
    }
    if (gameId === null) throw new ApiError("BAD_REQUEST", "筛选条件 gameId 不是有效的游戏", 400);
    if (categoryId === null) {
      throw new ApiError("BAD_REQUEST", "筛选条件 categoryId 不是有效的类目", 400);
    }
  }

  return buildAdminProductListQuery({
    params,
    gameId: gameId ?? "",
    categoryId: categoryId ?? "",
    status: status ?? "",
    recommended: recommended ?? "",
    removal: removal ?? "active",
  });
}

/**
 * 名册上下文：id → 名称，以及筛选栏 / 表单要用的选项。
 *
 * 游戏与类目**一次取回**：两个映射取自同一份数据，不会出现
 * 「筛选栏里有这个类目、列表里显示的是另一个名字」这种半生效状态。
 */
async function catalogContext(): Promise<{
  games: ProductGameOption[];
  categories: ProductCategoryOption[];
  gameNameById: Record<string, string>;
  categoryNameById: Record<string, string>;
}> {
  const catalog = getCatalogRepository();
  const [games, categories] = await Promise.all([catalog.listGames(), catalog.listCategories()]);

  return {
    games: games.map((game) => ({ id: game.id, name: game.name })),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      gameId: category.gameId,
      enabled: category.enabled,
      removedAt: category.removedAt,
    })),
    gameNameById: Object.fromEntries(games.map((game) => [game.id, game.name])),
    categoryNameById: Object.fromEntries(categories.map((category) => [category.id, category.name])),
  };
}

/**
 * 管理端商品列表。
 *
 * 走的是仓储里**唯一**的那份商品表（含已下架与已移除），因此「后台看到全部、
 * 用户端只看到上架且未移除的」这件事由数据层与 `lib/constants/catalog.ts` 保证。
 */
export async function queryAdminProductList(
  query: AdminProductListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminProductListData> {
  return withMockDebug(params, surface, async () => {
    const catalog = getCatalogRepository();
    const [context, active, removed] = await Promise.all([
      catalogContext(),
      // 角标要「全部商品」，而 `removal` 刻意**没有「全部」这个取值**
      // （见 `catalogRepository.ts`：默认视图是使用中的记录，看已移除的要显式选）。
      // 因此这里各取一次再合并，而不是给仓储加一个「什么都要」的口子——
      // 那个口子迟早会被某个列表误用，把已移除的记录混进正常视图。
      catalog.queryProductsForAdmin({
        keyword: "",
        gameId: "",
        categoryId: "",
        status: "",
        recommended: "",
        removal: "active",
      }),
      catalog.queryProductsForAdmin({
        keyword: "",
        gameId: "",
        categoryId: "",
        status: "",
        recommended: "",
        removal: "removed",
      }),
    ]);

    const counts = countAdminProductStates([...active, ...removed]);
    // `games` / `categories` 只给**筛选栏**用：选项来自真实目录，写死第二份迟早出现
    // 「界面上能选、数据里筛不出任何结果」的空选项。
    // 类目选项含停用与已移除，与列表里能看到的商品保持一致——否则带着
    // `?categoryId=已停用的类目` 打开这一页，筛选器会显示「全部类目」却只列出几条商品。
    const games = context.games;
    const categories = context.categories;

    if (mockEmptyApplies(params, "products")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        games,
        categories,
        counts,
        notice: ADMIN_PRODUCT_LIST_NOTICE,
      };
    }

    const rows = await catalog.queryProductsForAdmin({
      keyword: query.keyword,
      gameId: query.gameId,
      categoryId: query.categoryId,
      status: query.status,
      recommended: query.recommended,
      removal: query.removal,
    });

    const start = (query.page - 1) * query.pageSize;
    const items: AdminProductListItem[] = rows
      .slice(start, start + query.pageSize)
      .map((record) => toAdminProductListItem(record, context));

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: rows.length,
      hasMore: start + items.length < rows.length,
      games,
      categories,
      counts,
      notice: ADMIN_PRODUCT_LIST_NOTICE,
    };
  });
}

/**
 * 管理端商品详情。
 *
 * ⚠️ **已移除的商品仍然返回详情**：后台要能查到「这件商品被移除过」，
 * 返回 404 等于把移除变成了「记录消失」，那正是软删除要避免的事。
 * （用户端的直链是另一条路径：`findProductById()` 对已移除的商品返回 null。）
 */
export async function getAdminProductDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminProductListItem | null> {
  return withMockDebug(params, surface, async () => {
    const [record, context] = await Promise.all([
      getCatalogRepository().findProductForAdmin(id),
      catalogContext(),
    ]);

    return record ? toAdminProductListItem(record, context) : null;
  });
}

/** 新建 / 编辑表单要用的选项（游戏、类目、两组图片白名单）。 */
export async function getAdminProductFormOptions(): Promise<AdminProductFormOptions> {
  const { games, categories } = await catalogContext();
  return {
    games,
    categories,
    coverOptions: [...PRODUCT_COVER_OPTIONS],
    detailImageOptions: [...PRODUCT_DETAIL_IMAGE_OPTIONS],
  };
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————

function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_PRODUCT_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
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
 * 从请求体里读出一行规格。
 *
 * ⚠️ `id` 是**原样读入**的字符串，**绝不**在这里生成——「空串表示新增」这个约定
 * 由原子区段里的 `resolveSpecs()` 兑现，id 的生成必须是同步的、且必须在写入之前。
 * 也**绝不**用数组下标当身份：删掉中间一行就会让后面所有行的身份错位，
 * 而订单快照里记的正是这个 id。
 *
 * `priceYuan` 读的是**原始字符串**：金额的解析是 `parsePriceYuanToFen()` 的事，
 * 读入阶段不做任何数字转换，避免「先 parseFloat 再乘 100」这种浮点中间值混进来。
 */
function readSpecInputs(body: Record<string, unknown>): ProductSpecInput[] {
  const raw = body.specs;
  if (!Array.isArray(raw)) return [];

  return raw.map((item): ProductSpecInput => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      id: readTrimmedString(row, "id"),
      name: readTrimmedString(row, "name"),
      priceYuan: readTrimmedString(row, "priceYuan"),
      // 缺省用 NaN：让「规格排序只能是…」的校验报错，而不是静默当成 0
      sortOrder: readInteger(row, "sortOrder", Number.NaN),
      enabled: readBoolean(row, "enabled", true),
      removed: readBoolean(row, "removed", false),
    };
  });
}

/**
 * 从请求体里读出一份完整的商品输入。
 *
 * ⚠️ **入参就是白名单**：`monthlySales`（销量）、`gameTag`、`createdAt`、`updatedAt`、
 * `removedAt`、`id` 在这里**没有读取的位置**，客户端多传一个字段也不会有任何效果。
 * 这不是「忘了校验」，而是类型上就没有入口（§九：客户端伪造 ID、状态、时间、销量、
 * 统计字段必须被忽略）。
 */
function readProductInput(body: Record<string, unknown>): ProductProfileInput {
  const status = readTrimmedString(body, "status");
  return {
    gameId: readTrimmedString(body, "gameId"),
    categoryId: readTrimmedString(body, "categoryId"),
    title: readTrimmedString(body, "title"),
    subtitle: readTrimmedString(body, "subtitle"),
    coverUrl: readTrimmedString(body, "coverUrl"),
    tags: readStringArray(body, "tags"),
    detailText: readTrimmedString(body, "detailText"),
    detailImages: readStringArray(body, "detailImages"),
    sortOrder: readInteger(body, "sortOrder", Number.NaN),
    // 分账比例与规格单价一样按**原始字符串**读（界面单位是百分比）：
    // 换算成基点是服务端 `toProductDraft()` 的事，读入阶段不做数字转换。
    // 缺省给空串 → 校验报「分账比例请填 0 到 100 之间的百分比」，而不是静默取默认比例
    companionRatePercent: readTrimmedString(body, "companionRatePercent"),
    recommended: readBoolean(body, "recommended", false),
    // 只有明确的 `"on"` 才当作上架；其余（含缺省、写错）一律按**下架**处理。
    // 这个方向的默认值是刻意的：把一次误传当成「下架」最多让人再点一次上架，
    // 当成「上架」则会让一件还没准备好、甚至没有规格的商品直接出现在用户端。
    status: status === "on" ? "on" : "off",
    specs: readSpecInputs(body),
  };
}

/** 逐字段校验 → 入参；任何一处不过就抛 400，message 是**第一条**错误。 */
function validateProduct(
  input: ProductProfileInput,
  options: {
    games: ProductGameOption[];
    categories: ProductCategoryOption[];
    currentCoverUrl?: string;
    currentDetailImages?: readonly string[];
  },
): ProductDraft {
  const errors = productProfileFieldErrors(input, options);
  if (hasProductProfileError(errors)) {
    // 第一条错误按**页面上的字段顺序**取（`firstProductProfileErrorField`），
    // 接口调用方看不到表单，至少要能从响应里知道是哪个字段不对
    const field = firstProductProfileErrorField(errors);
    throw new ApiError(
      "BAD_REQUEST",
      (field && errors[field]) || ADMIN_PRODUCT_PROFILE_INVALID_MESSAGE,
      400,
    );
  }

  const patch = normalizeProductProfilePatch(input, options);
  if (!patch) throw new ApiError("BAD_REQUEST", ADMIN_PRODUCT_PROFILE_INVALID_MESSAGE, 400);
  // 元 → 分在这里发生，且只在这里。上面 `readSpecInputs()` 读到的 `priceYuan`
  // 一路都是文本，到这一步才变成实体里的整数分。
  return toProductDraft(patch);
}

/**
 * 伪事务的失败 → 接口错误。
 *
 * 十种失败各有各的处置，合并成一句「操作失败」会让调用方不知道该改游戏、
 * 改类目、补一条规格还是刷新页面。
 */
function toApiFailure(failure: AdminCatalogWriteFailure): ApiError {
  switch (failure.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_PRODUCT_NOT_FOUND_MESSAGE, 404);
    case "removed":
      return new ApiError("BAD_REQUEST", ADMIN_PRODUCT_REMOVED_MESSAGE, 400);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_PRODUCT_OPERATION_CONFLICT_MESSAGE, 400);
    case "game-invalid":
      return new ApiError("BAD_REQUEST", PRODUCT_GAME_INVALID_MESSAGE, 400);
    case "category-invalid":
      return new ApiError("BAD_REQUEST", PRODUCT_CATEGORY_INVALID_MESSAGE, 400);
    case "category-unavailable":
      return new ApiError("BAD_REQUEST", PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE, 400);
    case "no-effective-spec":
      return new ApiError("BAD_REQUEST", PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE, 400);
    case "unknown-spec":
      return new ApiError("BAD_REQUEST", ADMIN_PRODUCT_UNKNOWN_SPEC_MESSAGE, 400);
    case "duplicate-spec-id":
      return new ApiError("BAD_REQUEST", ADMIN_PRODUCT_DUPLICATE_SPEC_ID_MESSAGE, 400);
    case "price-invalid":
      // 正常路径上到不了这里（表单已经拦过），能到这里要么是直接调接口，
      // 要么是某条链路漏了转换。两种情况都该被明确拒绝，而不是写一个错的价格
      return new ApiError("BAD_REQUEST", SPEC_PRICE_INVALID_MESSAGE, 400);
    case "spec-order-invalid":
      // 同一句话也会作为**字段级**错误出现在规格行下面，两处同源
      return new ApiError("BAD_REQUEST", SPEC_SORT_ORDER_INVALID_MESSAGE, 400);
    default:
      // 类目那三种失败（重名 / 有商品）属于类目写操作，商品这条路径上出现只可能是接线错了
      return new ApiError("BAD_REQUEST", ADMIN_PRODUCT_PROFILE_INVALID_MESSAGE, 400);
  }
}

type TransactionOutcome = Awaited<ReturnType<typeof createProduct>>;

/** 伪事务结果 → 接口结果。成功只回状态字段，界面据此就地更新那一行。 */
function toWriteResult(outcome: TransactionOutcome): AdminProductWriteResult {
  if (outcome.kind !== "ok") throw toApiFailure(outcome);

  const { updated } = outcome.value;
  return toAdminProductWriteResult(updated.id, updated, outcome.changed);
}

/** 新建时没有「当前图片」，白名单之外一律不接受。 */
const NO_CURRENT_IMAGES: readonly string[] = [];

// ——————————————————————————— 六种写操作 ———————————————————————————

/**
 * 新建商品（含它的全部规格，一次原子写入）。
 *
 * 新建的商品 `monthlySales` 从 0、`gameTag` 从空开始：它们是统计与平台侧展示字段，
 * **不由后台写入**（§八），客户端传了也不会被读。
 */
export async function createAdminProduct(
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminProductWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const options = await getAdminProductFormOptions();
  const input = readProductInput(body);

  const draft = validateProduct(input, {
    games: options.games,
    categories: options.categories,
    // 新建时没有「当前图片」：唯一的来源就是白名单
    currentCoverUrl: "",
    currentDetailImages: NO_CURRENT_IMAGES,
  });

  return toWriteResult(await createProduct(draft, writeContext(adminId, operationId)));
}

/**
 * 编辑商品与它的全部规格（**一次原子写入**）。
 *
 * ⚠️ 「当前封面 / 当前详情图」要传给校验：预置数据里有一条封面地址刻意写错的调试商品，
 * 不放行当前值的话它连标题都改不动。这份「当前值」取自**服务端读到的记录**，
 * 而不是请求体——否则客户端只要把任意地址填进 `currentCoverUrl` 就绕过了白名单。
 */
export async function updateAdminProduct(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminProductWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const existing = await getCatalogRepository().findProductForAdmin(id);
  if (!existing) throw new ApiError("NOT_FOUND", ADMIN_PRODUCT_NOT_FOUND_MESSAGE, 404);
  if (existing.removedAt !== null) {
    throw new ApiError("BAD_REQUEST", ADMIN_PRODUCT_REMOVED_MESSAGE, 400);
  }

  const options = await getAdminProductFormOptions();
  const input = readProductInput(body);
  const draft = validateProduct(input, {
    games: options.games,
    categories: options.categories,
    currentCoverUrl: existing.coverUrl,
    currentDetailImages: existing.detailImages,
  });

  return toWriteResult(
    await updateProduct(id, draft, writeContext(adminId, operationId)),
  );
}

/**
 * 上架 / 下架（窄写入）。
 *
 * ⚠️ 与 `updateAdminProduct()` 分开：列表上的上下架按钮只应当改状态，
 * 而不是「读出整条商品、拼一个完整 patch 再写回去」——后者会在两位管理员
 * 同时操作时，用后写的那次把另一位刚改好的价格覆盖回旧值。
 *
 * 上架要求「类目可用 + 至少一个有效规格」，两条都在原子区段里判定。
 */
export async function setAdminProductStatus(
  id: string,
  status: ProductStatus,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminProductWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await setProductStatus(id, status, writeContext(adminId, operationId)));
}

/**
 * 移除商品（软删除）。
 *
 * ⚠️ 移除**不删除任何历史**：历史订单、收藏与评价记录都保留，
 * 只是用户端看不到它了（直链也是 404）。后台可以用「已移除」筛选把它找回来。
 */
export async function removeAdminProduct(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminProductWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await removeProduct(id, writeContext(adminId, operationId)));
}
