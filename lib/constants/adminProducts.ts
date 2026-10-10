import { formatYuan } from "@/lib/utils/format";
import { countCharacters } from "@/lib/utils/text";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type {
  AdminProductCategoryOption,
  AdminProductListItem,
  AdminProductSpecPatch,
  AdminProductWriteResult,
  CatalogProductRecord,
  ProductProfileDraft,
  ProductProfilePatch,
  ProductSpecInput,
  ProductSpecRecord,
  ProductStatus,
} from "@/lib/types/product";
import {
  isSpecEffective,
  listEffectiveSpecs,
  productDisplayPrice,
} from "./catalog";
import {
  readAdminCatalogId,
  readAdminCatalogKeyword,
  readAdminCatalogPaging,
  type AdminCatalogRemovalFilter,
} from "./adminCatalog";
import {
  SHARE_RATIO_INVALID_MESSAGE,
  SHARE_RATIO_LABEL,
  parseShareRatioPercentToBp,
} from "./shareRatio";

/**
 * 管理端「商品管理」的字段规则、金额转换、状态口径与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型、`./catalog`、`./adminCatalog` 与 `lib/utils/*` 外没有运行时依赖，
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 五组规则写在这里，它们都是 §商品规则 / §规格规则 的直接落点：
 *
 * 1. **金额只以整数分进入实体**。界面上输入的是**元**（`29.90`），转换在
 *    `parsePriceYuanToFen()` 里用**字符串**完成，不经过浮点乘法——
 *    `29.9 * 100` 在 IEEE754 下是 `2989.9999999999995`，`Math.round` 侥幸救回来，
 *    但 `1.005 * 100` 就不是了。「禁止浮点金额进入实体」因此不是靠四舍五入，
 *    而是靠根本不产生浮点中间值（见 §规格规则）。
 * 2. **图片只能选自本地白名单**。`isAllowedProductCover()` / `isAllowedProductDetailImage()`
 *    是仅有的两个入口，服务端与表单共用。当前值额外放行——否则一条封面地址不在白名单里的
 *    既有商品（例如 `/product/p-debug-broken-image`）将永远改不动标题，
 *    而这与「换图才需要重新选图」的直觉相反。
 * 3. **上架商品至少要有一个有效规格**。`effectiveSpecCount()` 是「有效」的唯一定义，
 *    与上架校验、列表角标、起售价三处共用。改价只影响之后的试算与支付，
 *    历史订单读的是下单快照，不受任何影响。
 * 4. **规格的身份是 id，不是下标**。表单提交的 `id` 为空串表示新增，非空必须是该商品
 *    已有的规格 id；认不出来的 id 在服务端被拒绝（`lib/data/adminCatalogTransaction.ts`），
 *    而不是当成新规格收下——否则一次手误会静默多出一条重复规格。
 * 5. **危险操作都要二次确认**。确认文案在这里，但确认框**不是**防重手段：
 *    真正的防重是服务端的幂等键与状态判断（§九：不能依赖按钮禁用防重）。
 */

export const ADMIN_PRODUCT_LIST_TITLE = "商品管理";
export const ADMIN_PRODUCT_NEW_TITLE = "新建商品";
export const ADMIN_PRODUCT_DETAIL_TITLE = "商品详情";
export const ADMIN_PRODUCT_EDIT_TITLE = "编辑商品";

/**
 * 列表页顶部的一句话。
 *
 * ⚠️ 这不是装饰文案：后台最容易犯的错是以为「这里的改动只影响后台」，
 * 而实际上首页、分类页、商品详情与结算页读的都是这一份数据。
 */
export const ADMIN_PRODUCT_LIST_NOTICE =
  "这里的改动会立即影响用户端的首页、分类页、商品详情与结算页——它们读的是同一份数据；历史订单读的是下单快照，不受影响。";

export const ADMIN_PRODUCT_EMPTY_MESSAGE = "当前筛选下没有商品。";
export const ADMIN_PRODUCT_REMOVED_EMPTY_MESSAGE = "没有已移除的商品。";

/** 列表默认每页条数。 */
export const ADMIN_PRODUCT_PAGE_SIZE = 10;

export const ADMIN_PRODUCT_COUNT_LABELS = {
  all: "全部商品",
  on: "已上架",
  off: "已下架",
  recommended: "已推荐",
  removed: "已移除",
} as const;

/** 详情页顶部说明：这些字段看着像能改，其实改了也没用——后台维护不了统计。 */
export const ADMIN_PRODUCT_READONLY_NOTICE =
  "销量、平台标签、创建时间由系统维护，页面只能查看；编辑表单里没有它们，接口也不接受。";

// ——————————————————————————— 字段规则 ———————————————————————————

/** 标题上限。预置数据里最长的一条是 26 个字，30 留出余量。 */
export const PRODUCT_TITLE_MAX_LENGTH = 30;
/** 副标题上限。预置数据里最长 15 个字。 */
export const PRODUCT_SUBTITLE_MAX_LENGTH = 20;
/** 图文详情的文字上限。 */
export const PRODUCT_DETAIL_TEXT_MAX_LENGTH = 500;
/** 规格名上限。预置数据里最长约 13 个字（「机密400万 · 三小时速通」）。 */
export const SPEC_NAME_MAX_LENGTH = 20;
/** 单个标签上限。预置数据里最长的是「只打巴克什」（5 个字）。 */
export const TAG_MAX_LENGTH = 8;
/** 一件商品最多几个标签。 */
export const TAG_MAX_COUNT = 4;
/** 图文详情最多几张图。 */
export const DETAIL_IMAGE_MAX_COUNT = 6;
/** 一个商品的规格条数上限。 */
export const SPEC_MAX_COUNT = 12;
/** 展示排序的取值范围。与护航、类目同一个区间，运营不必记两套数。 */
export const PRODUCT_SORT_ORDER_MIN = 0;
export const PRODUCT_SORT_ORDER_MAX = 9999;

/**
 * 单价上限：99999.99 元。
 *
 * 有上限不是为了限制定价，而是为了挡住 `999999999999` 这种手滑——
 * 一个天文数字的价格会直接写进结算金额，而结算页的金额展示是按分算的。
 */
export const SPEC_PRICE_MAX_FEN = 9_999_999;

/**
 * 元 → 分。**字符串解析，不产生浮点中间值。**
 *
 * 只接受 `123` / `123.4` / `123.45` 三种形状：
 * - 拒绝 `1e3`、`0x10`、`+1`、`-1`、`１２３`（全角）、`1,000`——
 *   它们要么不是人能读的价格，要么在别的语言里另有含义，猜错的代价是价格写错；
 * - 拒绝超过两位小数（`1.005` 无法精确表示成整数分，任何「就近取整」都是在替运营改价）；
 * - 拒绝 `0` 与负数（§规格规则：价格必须大于 0）。
 *
 * 返回值是**分**；不合法返回 null，由调用方决定给什么错误文案。
 *
 * ⚠️ 非字符串一律当成不合法（返回 null），**不是**先 `String()` 一下再解析。
 * 类型签名只约束 TypeScript，运行时（node 直接加载本模块、或将来某个 JS 调用方）
 * 完全可能塞进来一个数字：`10` 与 `"10"` 长得像，但 `0.1 + 0.2` 这种浮点结果
 * 一旦被 toString 就会变成一个看似合法的价格。拒绝比猜测安全。
 */
export function parsePriceYuanToFen(raw: string): number | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;

  const [yuanText, decimalsText = ""] = value.split(".");
  // 分 = 整数部分与补齐到两位的小数部分**拼成字符串**再转一次整数：
  // `"10"` → `"1000"` → 1000，`"10.5"` → `"1050"` → 1050。
  // 全程没有 `0.5` 或 `10.5` 这样的浮点中间值，因此 `1.005 * 100` 那种
  // 「乘完刚好差一点点、四舍五入又救回来」的路径根本不存在。
  // 前导零保持原样（`"09.90"` 仍是 990）：这里只搬格式，不动既有口径。
  const fen = Number(`${yuanText}${decimalsText.padEnd(2, "0")}`);

  if (!Number.isInteger(fen) || fen <= 0 || fen > SPEC_PRICE_MAX_FEN) return null;
  return fen;
}

/** 分 → 元，用于表单的初始值（`2990` → `"29.90"`）。与展示口径共用 `formatYuan`。 */
export function formatPriceFenForInput(fen: number): string {
  return formatYuan(fen);
}

/**
 * 标题里是否出现了价格。
 *
 * §商品规则：**标题不得包含价格前缀**。价格与名称是两个独立字段，
 * 混在一起之后，改价就会改出「机密400万 29元」这种自相矛盾的标题——
 * 而列表页显示的价格来自规格，两边一旦不一致，用户会以为自己看错了。
 *
 * ⚠️ 判定刻意**只认货币符号与「数字 + 元/块」**，不认「标题以数字开头」：
 * 「400万机密单」是一个完全合理的产品名（「万」在这里是数量单位，不是钱），
 * 把它拦下来会比漏掉几个变体更让人困惑。
 */
const CURRENCY_SYMBOL_PATTERN = /[¥￥$]/;
const PRICE_UNIT_PATTERN = /\d\s*(元|块钱?)/;

export function productTitleContainsPrice(title: string): boolean {
  return CURRENCY_SYMBOL_PATTERN.test(title) || PRICE_UNIT_PATTERN.test(title);
}

export const PRODUCT_TITLE_EMPTY_MESSAGE = "请填写商品标题";
export const PRODUCT_TITLE_TOO_LONG_MESSAGE = `商品标题不能超过 ${PRODUCT_TITLE_MAX_LENGTH} 个字符`;
export const PRODUCT_TITLE_PRICE_MESSAGE = "商品标题里不能包含价格，价格请写在规格里";
export const PRODUCT_SUBTITLE_TOO_LONG_MESSAGE = `商品副标题不能超过 ${PRODUCT_SUBTITLE_MAX_LENGTH} 个字符`;
export const PRODUCT_DETAIL_TEXT_TOO_LONG_MESSAGE = `图文详情文字不能超过 ${PRODUCT_DETAIL_TEXT_MAX_LENGTH} 个字符`;
export const PRODUCT_GAME_REQUIRED_MESSAGE = "请选择所属游戏";
export const PRODUCT_GAME_INVALID_MESSAGE = "所属游戏不是有效游戏，请重新选择";
export const PRODUCT_CATEGORY_REQUIRED_MESSAGE = "请选择所属类目";
export const PRODUCT_CATEGORY_INVALID_MESSAGE = "所选类目不属于所选游戏，请重新选择";
/**
 * 类目存在、但不属于这个游戏、或已停用 / 已移除时的提示。
 *
 * §类目规则：**停用或删除类目不能用于新建、编辑归属或上架商品**。
 * 这条提示只覆盖「类目本身不可用」；选错游戏有各自的提示，两者分开说，
 * 运营才知道该改游戏还是改类目。
 */
export const PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE = "所选类目已停用或已移除，不能用于商品归属";
export const PRODUCT_SORT_ORDER_INVALID_MESSAGE = `展示排序只能是 ${PRODUCT_SORT_ORDER_MIN} 到 ${PRODUCT_SORT_ORDER_MAX} 之间的整数`;
export const PRODUCT_COVER_INVALID_MESSAGE = "封面只能选择白名单里的 Mock 图片";
export const PRODUCT_DETAIL_IMAGE_INVALID_MESSAGE = "图文详情图片只能选择白名单里的 Mock 图片";
export const PRODUCT_DETAIL_IMAGE_TOO_MANY_MESSAGE = `图文详情最多 ${DETAIL_IMAGE_MAX_COUNT} 张图片`;
export const PRODUCT_TAG_TOO_MANY_MESSAGE = `最多 ${TAG_MAX_COUNT} 个标签`;
export const PRODUCT_TAG_EMPTY_MESSAGE = "标签不能为空";
export const PRODUCT_TAG_TOO_LONG_MESSAGE = `单个标签不能超过 ${TAG_MAX_LENGTH} 个字符`;
export const PRODUCT_TAG_DUPLICATE_MESSAGE = "标签不能重复";

/** 规格数组整体为空。 */
export const PRODUCT_SPEC_EMPTY_MESSAGE = "请至少添加一条规格";
export const PRODUCT_SPEC_TOO_MANY_MESSAGE = `最多 ${SPEC_MAX_COUNT} 条规格`;
export const SPEC_NAME_EMPTY_MESSAGE = "请填写规格名称";
export const SPEC_NAME_TOO_LONG_MESSAGE = `规格名称不能超过 ${SPEC_NAME_MAX_LENGTH} 个字符`;
export const SPEC_NAME_DUPLICATE_MESSAGE = "同一商品内有效规格名不能重复";
export const SPEC_PRICE_INVALID_MESSAGE = `单价必须大于 0，最多两位小数，且不超过 ${formatYuan(SPEC_PRICE_MAX_FEN)} 元`;
export const SPEC_SORT_ORDER_INVALID_MESSAGE = `规格排序只能是 ${PRODUCT_SORT_ORDER_MIN} 到 ${PRODUCT_SORT_ORDER_MAX} 之间的整数`;
/**
 * 上架商品不能失去最后一个有效规格。
 *
 * 同一个常量同时服务三个入口（新建时就上架、把商品上架、保存一份会清空有效规格的列表），
 * 因为它们本来就是同一件事：一件在架却没有可选规格的商品，点进去是一页买不了的东西。
 */
export const PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE =
  "该商品已上架，至少要保留一个启用且未移除的规格；也可以先把商品下架";

export const PRODUCT_FIELD_LABELS = {
  gameId: "所属游戏",
  categoryId: "所属类目",
  title: "商品标题",
  subtitle: "商品副标题",
  coverUrl: "商品封面",
  tags: "商品标签",
  detailText: "图文详情",
  detailImages: "详情图片",
  sortOrder: "展示排序",
  companionRatePercent: SHARE_RATIO_LABEL,
  recommended: "推荐状态",
  status: "上下架状态",
  specs: "商品规格",
} as const;

/** 编辑表单的字段名。页面据此把错误定位到具体输入框（`aria-invalid` / `aria-describedby`）。 */
export type ProductProfileField = keyof typeof PRODUCT_FIELD_LABELS;

/**
 * 各字段的错误；没有错误为 null。
 *
 * ⚠️ `specs` 这里放的是**规格组整体**的错误（空、超条数、重名、有效规格不足），
 * 单条规格的名称与单价错误在 `ProductSpecRowErrors` 里逐行给出——
 * 两者分开，页面才能既给整组一条说明、又把 `aria-invalid` 落到具体那一行的输入框上。
 */
export type ProductProfileFieldErrors = Record<ProductProfileField, string | null>;

const NO_ERRORS: ProductProfileFieldErrors = {
  gameId: null,
  categoryId: null,
  title: null,
  subtitle: null,
  coverUrl: null,
  tags: null,
  detailText: null,
  detailImages: null,
  sortOrder: null,
  companionRatePercent: null,
  recommended: null,
  status: null,
  specs: null,
};

/**
 * 单条规格行的字段错误，下标与提交的 `specs` 数组一一对应。
 *
 * `sortOrder` 也在里面：它是**每一行自己的**字段，跟商品级的「展示排序」不是一回事。
 * 少这一个键，一行排序写成「abc」就会在界面上看起来完全正常，
 * 直到服务端拒绝——而拒绝信息会落在表单底部，人不一定知道是哪一行。
 */
export type ProductSpecRowError = {
  name: string | null;
  price: string | null;
  sortOrder: string | null;
};

export type ProductSpecRowErrors = ProductSpecRowError[];

/** 表单里可以填的原始值（文本都是字符串，勾选框是布尔）。 */
export type ProductProfileInput = {
  gameId: string;
  categoryId: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  tags: readonly string[];
  detailText: string;
  detailImages: readonly string[];
  sortOrder: number;
  /** 分账比例：界面单位是**百分比文本**（`"80"`、`"80.5"`），不是基点 */
  companionRatePercent: string;
  recommended: boolean;
  status: ProductStatus;
  specs: readonly ProductSpecInput[];
};

/** 校验用的游戏 / 类目选项。类目带上归属与可用性，供「必须属于所选游戏且可用」判断。 */
export type ProductGameOption = { id: string; name: string };
/**
 * 类目选项。
 *
 * 直接复用管理端 DTO 的形状（`AdminProductCategoryOption`），而不是在这里再写一遍
 * 一模一样的字段：校验读的就是服务端返回的那份选项，两份结构一旦分叉，
 * 校验就会开始接受或拒绝错误的东西，而那种错误只在特定数据下才出现。
 */
export type ProductCategoryOption = AdminProductCategoryOption;

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

function validateTitle(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: PRODUCT_TITLE_EMPTY_MESSAGE };
  if (countCharacters(value) > PRODUCT_TITLE_MAX_LENGTH) {
    return { ok: false, message: PRODUCT_TITLE_TOO_LONG_MESSAGE };
  }
  if (productTitleContainsPrice(value)) {
    return { ok: false, message: PRODUCT_TITLE_PRICE_MESSAGE };
  }
  return { ok: true, value };
}

function validateSubtitle(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (countCharacters(value) > PRODUCT_SUBTITLE_MAX_LENGTH) {
    return { ok: false, message: PRODUCT_SUBTITLE_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

function validateDetailText(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (countCharacters(value) > PRODUCT_DETAIL_TEXT_MAX_LENGTH) {
    return { ok: false, message: PRODUCT_DETAIL_TEXT_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

function validateTags(raw: readonly string[]): FieldResult<string[]> {
  const seen = new Set<string>();
  const value: string[] = [];

  for (const item of raw) {
    const tag = item.trim();
    // 空串跳过而不是报错：标签输入框里敲了一个空回车不是错误，只是没有内容
    if (!tag) continue;
    if (countCharacters(tag) > TAG_MAX_LENGTH) {
      return { ok: false, message: PRODUCT_TAG_TOO_LONG_MESSAGE };
    }
    if (seen.has(tag)) return { ok: false, message: PRODUCT_TAG_DUPLICATE_MESSAGE };
    seen.add(tag);
    value.push(tag);
  }

  if (value.length > TAG_MAX_COUNT) return { ok: false, message: PRODUCT_TAG_TOO_MANY_MESSAGE };
  return { ok: true, value };
}

/**
 * 规格行的逐行错误 + 整组错误。
 *
 * 两件事在这里一次算完，页面拿同一份结果既标具体行、也标整组：
 * - **逐行**：名称必填 / 不超长，单价必须是合法的元字符串，排序必须是区间内的整数；
 * - **整组**：至少一条、不超条数、**有效规格名不重复**。
 *
 * ⚠️ 重名只查**有效规格**（启用且未移除）：§规格规则说的是「同商品内**有效**规格名唯一」。
 * 一条停用或已移除的规格可以保留与别人相同的名字——它已经不在可选集合里，
 * 强行要求它改名只会让「先停用、回头再启用」这条正常操作走不通。
 *
 * ⚠️ 已标记移除的行**仍然要填得合法**：它不会被物理删除（订单快照里记着它的 id），
 * 记录里留着的就是这份值。与其把非法值悄悄改成 0，不如让人看见哪一行不对。
 */
export function productSpecErrors(specs: readonly ProductSpecInput[]): {
  rows: ProductSpecRowErrors;
  group: string | null;
} {
  const rows: ProductSpecRowErrors = [];
  const effectiveNames = new Set<string>();
  const effectiveNameCounts = new Map<string, number>();

  // 先数一遍有效规格的重名：只有重复出现的名字才是错误，第一次出现不能算
  for (const spec of specs) {
    if (spec.removed || !spec.enabled) continue;
    const name = spec.name.trim();
    if (!name) continue;
    effectiveNameCounts.set(name, (effectiveNameCounts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of effectiveNameCounts) {
    if (count > 1) effectiveNames.add(name);
  }

  for (const spec of specs) {
    const name = spec.name.trim();
    const nameError = !name
      ? SPEC_NAME_EMPTY_MESSAGE
      : countCharacters(name) > SPEC_NAME_MAX_LENGTH
        ? SPEC_NAME_TOO_LONG_MESSAGE
        : effectiveNames.has(name)
          ? SPEC_NAME_DUPLICATE_MESSAGE
          : null;

    const priceError =
      parsePriceYuanToFen(spec.priceYuan) === null ? SPEC_PRICE_INVALID_MESSAGE : null;

    // 排序与商品级的展示排序同一区间：空串与非数字在表单里是 NaN，这里一并挡下。
    // 放行 NaN 的后果不是「排序不生效」，而是 `NaN` 被写进实体，
    // 之后每次排序比较都为假——顺序变成随机的，而且再也查不出原因
    const sortOrderError =
      Number.isInteger(spec.sortOrder) &&
      spec.sortOrder >= PRODUCT_SORT_ORDER_MIN &&
      spec.sortOrder <= PRODUCT_SORT_ORDER_MAX
        ? null
        : SPEC_SORT_ORDER_INVALID_MESSAGE;

    rows.push({ name: nameError, price: priceError, sortOrder: sortOrderError });
  }

  const group =
    specs.length === 0
      ? PRODUCT_SPEC_EMPTY_MESSAGE
      : specs.length > SPEC_MAX_COUNT
        ? PRODUCT_SPEC_TOO_MANY_MESSAGE
        : null;

  return { rows, group };
}

/**
 * 推导编辑表单各字段的错误。
 *
 * 与入驻申请、护航编辑、类目编辑同一套做法：**逐字段给出一条**最终会生效的错误，
 * 页面拿它做 `aria-invalid` / `aria-describedby`，并把第一条出错的字段聚焦过去。
 *
 * 校验顺序即页面上的字段顺序——「第一条错误」因此是「最靠上的那条」。
 * `specs` 排在最后，因为规格编辑器在表单最下面。
 */
export function productProfileFieldErrors(
  input: ProductProfileInput,
  options: {
    games: readonly ProductGameOption[];
    categories: readonly ProductCategoryOption[];
    /** 该商品当前已用的封面 / 详情图：它们可能不在白名单里，但必须继续被接受 */
    currentCoverUrl?: string;
    currentDetailImages?: readonly string[];
  },
): ProductProfileFieldErrors {
  const title = validateTitle(input.title);
  const subtitle = validateSubtitle(input.subtitle);
  const detailText = validateDetailText(input.detailText);
  const tags = validateTags(input.tags);

  const gameId = input.gameId.trim();
  const gameError = !gameId
    ? PRODUCT_GAME_REQUIRED_MESSAGE
    : !options.games.some((game) => game.id === gameId)
      ? PRODUCT_GAME_INVALID_MESSAGE
      : null;

  const categoryId = input.categoryId.trim();
  const category = options.categories.find((item) => item.id === categoryId) ?? null;
  const categoryError = !categoryId
    ? PRODUCT_CATEGORY_REQUIRED_MESSAGE
    : !category || (gameError === null && category.gameId !== gameId)
      ? PRODUCT_CATEGORY_INVALID_MESSAGE
      : category.removedAt !== null || !category.enabled
        ? PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE
        : null;

  const coverUrl = input.coverUrl.trim();
  const coverError = isAllowedProductCover(
    coverUrl,
    options.currentCoverUrl ? [options.currentCoverUrl] : [],
  )
    ? null
    : PRODUCT_COVER_INVALID_MESSAGE;

  const detailImages = input.detailImages.map((url) => url.trim()).filter(Boolean);
  const currentDetail = options.currentDetailImages ?? [];
  const detailImageError = detailImages.some(
    (url) => !isAllowedProductDetailImage(url, currentDetail),
  )
    ? PRODUCT_DETAIL_IMAGE_INVALID_MESSAGE
    : detailImages.length > DETAIL_IMAGE_MAX_COUNT
      ? PRODUCT_DETAIL_IMAGE_TOO_MANY_MESSAGE
      : null;

  const sortOrderError = Number.isInteger(input.sortOrder)
    ? input.sortOrder < PRODUCT_SORT_ORDER_MIN || input.sortOrder > PRODUCT_SORT_ORDER_MAX
      ? PRODUCT_SORT_ORDER_INVALID_MESSAGE
      : null
    : PRODUCT_SORT_ORDER_INVALID_MESSAGE;

  // 分账比例：判定与换算共用 `parseShareRatioPercentToBp()`，因此「校验通过」与
  // 「转换得出一个数」是同一件事——不会出现「校验说没问题，转换却得到 null」的缝。
  // 转换本身在 `toProductDraft()` 里做，这一层只回答「能不能转」。
  const companionRateError =
    parseShareRatioPercentToBp(input.companionRatePercent) === null
      ? SHARE_RATIO_INVALID_MESSAGE
      : null;

  const spec = productSpecErrors(input.specs);
  const noEffectiveSpec =
    input.status === "on" && effectiveSpecCountFromInput(input.specs) === 0
      ? PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE
      : null;

  /**
   * 规格行里最靠上的一条错误。
   *
   * ⚠️ 这一条**必须**进 `specs`，否则一次「某一行单价写错」会被整体判定为「没问题」：
   * 逐行错误不在字段级错误的键里（每一行都是同一个字段），`hasProductProfileError()`
   * 看不到它，于是表单会提交、`normalizeProductProfilePatch()` 会成功，
   * 那一行的价格就会以一个兜底值写进实体。逐行错误是给**每一行的输入框**标红用的，
   * 这一条是给「整组算不算错」用的，两者都要有。
   */
  const specRowError =
    spec.rows
      .flatMap((row) => [row.name, row.price, row.sortOrder])
      .find((message) => message !== null) ?? null;

  return {
    ...NO_ERRORS,
    gameId: gameError,
    categoryId: categoryError,
    title: title.ok ? null : title.message,
    subtitle: subtitle.ok ? null : subtitle.message,
    coverUrl: coverError,
    tags: tags.ok ? null : tags.message,
    detailText: detailText.ok ? null : detailText.message,
    detailImages: detailImageError,
    sortOrder: sortOrderError,
    companionRatePercent: companionRateError,
    // 优先报「在架却买不了」：它比「某一行名字超长」严重得多，而且往往正是
    // 那行改动导致的后果，先说后果，人才知道为什么要改
    specs: noEffectiveSpec ?? spec.group ?? specRowError,
  };
}

/** 表单是否有错。页面用它决定「不提交、把第一条错误聚焦过来」。 */
export function hasProductProfileError(errors: ProductProfileFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/** 「第一条错」的字段名，按页面上的字段顺序。全部通过时返回 null。 */
export function firstProductProfileErrorField(
  errors: ProductProfileFieldErrors,
): ProductProfileField | null {
  for (const field of Object.keys(PRODUCT_FIELD_LABELS) as ProductProfileField[]) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * 原始输入 → **线上入参**（表单发给服务端的那份 JSON，也是服务端重新解析的那份）。
 *
 * ⚠️ 返回 `null` 表示**校验没过**，调用方必须先 `productProfileFieldErrors()` 拿到
 * 逐字段的错误再决定怎么办。这里再挡一次，是为了让「忘了先校验」也不可能发出脏数据。
 *
 * 两条归一化：
 * - 文本字段去掉首尾空白；
 * - `specs` 原样保留顺序与 `id`（空串表示新增），**绝不用下标当身份**。
 *
 * ⚠️ **金额不在这一层转分**：产物里的规格行仍是 `priceYuan` 元文本，客户端因此
 * 根本没有「传分」的通道。元转分是服务端 `toProductDraft()` 的事，那里才是唯一
 * 一处把界面金额变成整数分的地方。
 */
export function normalizeProductProfilePatch(
  input: ProductProfileInput,
  options: {
    games: readonly ProductGameOption[];
    categories: readonly ProductCategoryOption[];
    currentCoverUrl?: string;
    currentDetailImages?: readonly string[];
  },
): ProductProfilePatch | null {
  const errors = productProfileFieldErrors(input, options);
  if (hasProductProfileError(errors)) return null;

  const specs: ProductSpecInput[] = input.specs.map((spec) => ({
    id: spec.id,
    name: spec.name.trim(),
    // 只去空白，不解析：`10`、`10.5`、` 10 ` 到这里仍是元文本，
    // 严格校验与转换都由服务端的 `toProductDraft()` 做
    priceYuan: spec.priceYuan.trim(),
    sortOrder: spec.sortOrder,
    enabled: spec.enabled,
    removed: spec.removed,
  }));

  return {
    gameId: input.gameId.trim(),
    categoryId: input.categoryId.trim(),
    title: input.title.trim(),
    subtitle: input.subtitle.trim(),
    coverUrl: input.coverUrl.trim(),
    tags: [...input.tags.map((tag) => tag.trim()).filter(Boolean)],
    detailText: input.detailText.trim(),
    detailImages: input.detailImages.map((url) => url.trim()).filter(Boolean),
    sortOrder: input.sortOrder,
    // 与 `priceYuan` 同样只去空白、不换算：产物里的比例仍是百分比文本，
    // 客户端因此没有「传基点」的通道（换算只在服务端的 `toProductDraft()`）
    companionRatePercent: input.companionRatePercent.trim(),
    recommended: input.recommended,
    status: input.status,
    specs,
  };
}

/**
 * 线上入参 → **服务端内部草稿**：规格的元文本在这里转成整数分。
 *
 * ⚠️ 这是**唯一**一处把界面金额变成分的代码，只有服务端调用它
 * （`lib/services/adminProducts.ts` 的 `validateProduct()`）。界面拿到的
 * 始终是 `priceYuan` 元文本，所以「服务端是金额的最终权威」不是一句约定，
 * 而是客户端结构上就没有传分的字段。
 *
 * ⚠️ 转换走 `parsePriceYuanToFen()`：先整串匹配十进制格式，再由整数部分与小数部分
 * 拼出分，**不经过 `parseFloat() * 100`**——`10 * 100` 侥幸是 1000，
 * 但 `1.005 * 100` 是 100.49999999999999，浮点误差会把非法值洗成合法值。
 */
export function toProductDraft(patch: ProductProfilePatch): ProductProfileDraft {
  const specs: AdminProductSpecPatch[] = patch.specs.map((spec) => {
    // 走到这里说明每一行都已经通过校验（逐行错误也进了 `specs` 整组错误），
    // `parsePriceYuanToFen` 必然返回整数分。兜底值仍然写着，但**不会**悄悄落库：
    // 数据层（`lib/data/adminCatalogTransaction.ts`）会拒绝任何非整数或非正的单价，
    // 那次写入整体失败。这里给 0 只是为了让类型收敛，不是一条备用路径。
    const price = parsePriceYuanToFen(spec.priceYuan);
    return {
      id: spec.id,
      name: spec.name,
      price: price === null ? 0 : price,
      sortOrder: spec.sortOrder,
      enabled: spec.enabled,
      removed: spec.removed,
    };
  });

  // 百分比 → 基点：与金额一样，**唯一**一次把界面单位变成存储单位的地方。
  const { companionRatePercent, ...profile } = patch;
  const rateBp = parseShareRatioPercentToBp(companionRatePercent);
  if (rateBp === null) {
    // ⚠️ 与规格金额不同，这里**没有兜底值**。金额兜底成 0 会被数据层以
    // 「单价必须为正整数」整次拒绝，而比例兜底成 0 是一个**合法值**
    // （0% 表示全额归平台）：它会安安静静地按「平台拿走全部」结算，
    // 等到有人对账才可能发现。因此这一条走不变量断言——真发生了就整次失败，
    // 让 bug 当场暴露。走到这里说明校验与换算对同一个字符串给出了不同结论。
    throw new Error(`分账比例已通过校验却无法换算成基点：${JSON.stringify(companionRatePercent)}`);
  }

  return { ...profile, companionRateBp: rateBp, specs };
}

/**
 * 这次编辑对应哪一个审计动作。
 *
 * 上下架状态的变化优先于其它：一次「保存并把商品下架」记成「下架商品」比记成
 * 「编辑商品」准确得多——看审计的人先要知道的是「它什么时候不在架上了」。
 */
export function adminProductActionFromPatch(
  previous: Pick<CatalogProductRecord, "status">,
  status: ProductStatus,
): AdminAuditAction {
  if (previous.status !== status) {
    return status === "on" ? "product.publish" : "product.unpublish";
  }
  return "product.update";
}

/**
 * 这次编辑是否什么都没改。没改就不写数据、也不写审计。
 *
 * ⚠️ 收的是**草稿形状**（`ProductProfileDraft`）而不是线上入参形状：
 * 这一层比较的是「记录会被写成什么样」，金额与比例都已经是存储单位。
 * 少比一个字段的后果不是「多写一次」，而是**那次修改被静默丢弃**——
 * 页面提示保存成功，记录里还是旧值。
 */
export function isProductProfileUnchanged(
  previous: CatalogProductRecord,
  patch: Omit<ProductProfileDraft, "specs"> & { specs: readonly ProductSpecRecord[] },
): boolean {
  return (
    previous.gameId === patch.gameId &&
    previous.categoryId === patch.categoryId &&
    previous.title === patch.title &&
    previous.subtitle === patch.subtitle &&
    previous.coverUrl === patch.coverUrl &&
    sameList(previous.tags, patch.tags) &&
    previous.detailText === patch.detailText &&
    sameList(previous.detailImages, patch.detailImages) &&
    previous.sortOrder === patch.sortOrder &&
    previous.companionRateBp === patch.companionRateBp &&
    previous.recommended === patch.recommended &&
    previous.status === patch.status &&
    sameSpecs(previous.specs, patch.specs)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * 两份规格列表是否等价。**按 id 配对，不看数组顺序。**
 *
 * 不按下标比较，是因为数组顺序在这里没有意义：展示顺序由 `sortOrder` 决定
 * （见 `compareSpecsForList`）。按下标比的话，客户端把两行上下挪一下、
 * `sortOrder` 一个都没改，也会被当成一次真实变更写进审计——
 * 而审计里会留下一条看不出改了什么的记录。
 */
function sameSpecs(a: readonly ProductSpecRecord[], b: readonly ProductSpecRecord[]): boolean {
  if (a.length !== b.length) return false;

  const byId = new Map(b.map((spec) => [spec.id, spec]));
  return a.every((spec) => {
    const other = byId.get(spec.id);
    return (
      other !== undefined &&
      spec.name === other.name &&
      spec.price === other.price &&
      spec.sortOrder === other.sortOrder &&
      spec.enabled === other.enabled &&
      spec.removedAt === other.removedAt
    );
  });
}

// ——————————————————————————— 有效规格 ———————————————————————————

/** 一批规格里**有效**的条数（启用且未移除）。上架校验、角标与起售价共用这一个口径。 */
export function effectiveSpecCount(specs: readonly Pick<ProductSpecRecord, "enabled" | "removedAt">[]): number {
  return specs.filter(isSpecEffective).length;
}

/**
 * 一份规格输入里**有效**的条数。
 *
 * 输入是表单里的行（`enabled` + `removed`），实体里是 `enabled` + `removedAt`，
 * 两种形状都要判，因此这里把「有效」的输入侧口径也写出来，与 `isSpecEffective()`
 * 是同一条规则的两面。只在表单校验里用。
 */
export function effectiveSpecCountFromInput(specs: readonly ProductSpecInput[]): number {
  return specs.filter((spec) => spec.enabled && !spec.removed).length;
}

// ——————————————————————————— 图片白名单 ———————————————————————————

/**
 * 封面白名单：`public/mock` 下的四张商品图。
 *
 * ⚠️ 本阶段**没有对象存储、没有真实上传**：只能从这里挑一张本地占位图，
 * 存下来的是 public 下的资源地址。因此既不会保存操作员机器的完整文件路径
 * （`C:\Users\...\a.png` 这类），也不会伪造一个并不存在的远程图片地址。
 */
export const PRODUCT_COVER_OPTIONS: readonly string[] = [
  "/mock/product-cover-1.svg",
  "/mock/product-cover-2.svg",
  "/mock/product-cover-3.svg",
  "/mock/product-cover-4.svg",
];

/**
 * 图文详情可用的图片：四张封面 + 活动图 + 两张公告图。
 *
 * 比封面白名单宽，是因为详情图承担的是「补几张说明性的图」，用活动图与公告图
 * 是合理的；而封面必须是一张商品图，混进一张公告图会让列表看起来像贴错了。
 */
export const PRODUCT_DETAIL_IMAGE_OPTIONS: readonly string[] = [
  ...PRODUCT_COVER_OPTIONS,
  "/mock/promo-activity.svg",
  "/mock/announcement-1.svg",
  "/mock/announcement-2.svg",
];

/**
 * 封面地址是否可接受：必须是白名单里的一张，**或者就是该商品当前已经存着的地址**。
 *
 * 放行当前值不是通融，而是必须的：预置数据里有一条封面地址刻意写错的调试商品
 * （`/product/p-debug-broken-image`，用来验证「主图加载失败」占位），
 * 不放行的话，它连标题都改不动——而「只想改个标题却被迫先换一张图」是个说不通的规则。
 * 其余一律拒绝，避免把任意字符串（本地路径、编造的远程地址）写进记录。
 */
export function isAllowedProductCover(url: string, currentUrls: readonly string[]): boolean {
  if (PRODUCT_COVER_OPTIONS.includes(url)) return true;
  return url !== "" && currentUrls.includes(url);
}

/** 详情图地址是否可接受。规则同封面：白名单，或该商品当前已经存着的地址。 */
export function isAllowedProductDetailImage(
  url: string,
  currentUrls: readonly string[],
): boolean {
  if (PRODUCT_DETAIL_IMAGE_OPTIONS.includes(url)) return true;
  return url !== "" && currentUrls.includes(url);
}

// ——————————————————————————— 状态口径 ———————————————————————————

/**
 * 一条商品在后台眼里的状态。**三个取值互斥且有序**，优先级从上到下：
 * 已移除 > 已下架 > 已上架。
 *
 * §十一 要求**状态不能只靠颜色表达**，因此每一条记录都必然带一句可读的文字。
 */
export type AdminProductStatusKey = "removed" | "off" | "on";

export type AdminProductStatus = {
  key: AdminProductStatusKey;
  label: string;
  description: string;
};

const PRODUCT_STATUS_TEXT: Record<AdminProductStatusKey, { label: string; description: string }> =
  {
    removed: { label: "已移除", description: "用户端不可见（直链也是 404），历史订单保留" },
    off: { label: "已下架", description: "不出现在列表里，直链显示「已下架」且不能结算" },
    on: { label: "已上架", description: "出现在用户端列表与首页推荐里，可以结算" },
  };

export function adminProductStatus(
  record: Pick<CatalogProductRecord, "status" | "removedAt">,
): AdminProductStatus {
  const key: AdminProductStatusKey =
    record.removedAt !== null ? "removed" : record.status === "on" ? "on" : "off";

  return { key, ...PRODUCT_STATUS_TEXT[key] };
}

// ——————————————————————————— 列表查询 ———————————————————————————

export type AdminProductListQuery = {
  /** 空串表示不搜索 */
  keyword: string;
  /** 空串表示全部游戏 */
  gameId: string;
  /** 空串表示全部类目 */
  categoryId: string;
  status: "" | "on" | "off";
  recommended: "" | "recommended" | "normal";
  removal: AdminCatalogRemovalFilter;
  page: number;
  pageSize: number;
};

export function buildAdminProductListQuery(input: {
  params: URLSearchParams;
  gameId: string;
  categoryId: string;
  status: "" | "on" | "off";
  recommended: "" | "recommended" | "normal";
  removal: AdminCatalogRemovalFilter;
}): AdminProductListQuery {
  const { page, pageSize } = readAdminCatalogPaging(input.params, ADMIN_PRODUCT_PAGE_SIZE);

  return {
    keyword: readAdminCatalogKeyword(input.params.get("keyword")),
    gameId: input.gameId,
    categoryId: input.categoryId,
    status: input.status,
    recommended: input.recommended,
    removal: input.removal,
    page,
    pageSize,
  };
}

/** id 类筛选的读取规则与类目共用（`./adminCatalog`），这里给两个好读的名字。 */
export const readAdminProductGameId = readAdminCatalogId;
export const readAdminProductCategoryId = readAdminCatalogId;

// ——————————————————————————— 二次确认（§八） ———————————————————————————

/**
 * 三种危险动作的二次确认文案。
 *
 * ⚠️ 二次确认是**界面上的**保障，它挡不住网络重试与并发请求。真正的防重是
 * 幂等键加服务端的状态判断（§九：不能依赖按钮禁用防重），确认框只负责让人看清后果。
 */
export const ADMIN_PRODUCT_CONFIRM_TEXTS = {
  publish:
    "上架后该商品出现在用户端列表与首页推荐里，并可以结算；" +
    "上架要求至少有一个启用且未移除的规格。确定上架？",
  unpublish:
    "下架后该商品从用户端列表消失，直链打开会显示「已下架」且不能结算；" +
    "已经下单的历史订单不受影响。确定下架？",
  remove:
    "移除后该商品从用户端完全消失（直链也是 404），后台只能用「使用中 / 已移除」筛选切换查看；" +
    "历史订单、收藏与评价记录保留，不会删除。确定移除？",
} as const;

/** 动作按钮的文案。列表与详情共用同一份，不出现两种叫法。 */
export const ADMIN_PRODUCT_ACTION_LABELS = {
  publish: "上架",
  unpublish: "下架",
  remove: "移除",
  save: "保存修改",
  create: "新建商品",
} as const;

// ——————————————————————————— 服务端提示 ———————————————————————————

export const ADMIN_PRODUCT_NOT_FOUND_MESSAGE = "商品不存在";
export const ADMIN_PRODUCT_REMOVED_MESSAGE = "该商品已移除，不能再编辑或上下架";
export const ADMIN_PRODUCT_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_PRODUCT_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";
/** 字段校验未通过时的兜底提示（正常情况下字段级错误已经由表单给出）。 */
export const ADMIN_PRODUCT_PROFILE_INVALID_MESSAGE = "商品资料校验未通过，请检查表单";
/** 提交里出现了一个不属于该商品的规格 id。 */
export const ADMIN_PRODUCT_UNKNOWN_SPEC_MESSAGE = "提交的规格不属于该商品，请刷新页面后重试";
export const ADMIN_PRODUCT_DUPLICATE_SPEC_ID_MESSAGE = "同一条规格在提交里出现了两次";

// ——————————————————————————— DTO 转换 ———————————————————————————

/**
 * 内部实体 → 管理端列表项 / 详情。
 *
 * ⚠️ **显式挑字段**：不是 `{ ...record }` 再删几个，实体新增字段时默认不外流。
 * `specs` **全部返回**（含停用与已移除）——后台要能看见并管理它们，
 * 这与用户端 DTO 只给有效规格正好相反，也是两个 DTO 必须分开的原因。
 */
export function toAdminProductListItem(
  record: CatalogProductRecord,
  context: {
    gameNameById: Readonly<Record<string, string>>;
    categoryNameById: Readonly<Record<string, string>>;
  },
): AdminProductListItem {
  return {
    id: record.id,
    title: record.title,
    subtitle: record.subtitle,
    coverUrl: record.coverUrl,
    gameId: record.gameId,
    gameName: context.gameNameById[record.gameId] ?? record.gameId,
    categoryId: record.categoryId,
    // 类目已被硬删 / 查不到时退回 id 而不是空串：空串会让「它到底挂在哪」变成一个空白
    categoryName:
      record.categoryId === null
        ? ""
        : (context.categoryNameById[record.categoryId] ?? record.categoryId),
    tags: [...record.tags],
    detailText: record.detailText,
    detailImages: [...record.detailImages],
    sortOrder: record.sortOrder,
    recommended: record.recommended,
    status: record.status,
    // 分账比例给的是**基点**；表单用 `formatShareRatioBpForInput()` 显示成百分比
    companionRateBp: record.companionRateBp,
    removedAt: record.removedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    effectiveSpecCount: listEffectiveSpecs(record).length,
    specCount: record.specs.length,
    priceFrom: productDisplayPrice(record),
    monthlySales: record.monthlySales,
    gameTag: record.gameTag,
    specs: record.specs.map((spec) => ({ ...spec })),
  };
}

/** 写操作的返回。界面据此就地更新那一行，不必为了刷新一个开关重拉整页。 */
export function toAdminProductWriteResult(
  productId: string,
  updated: Pick<CatalogProductRecord, "status" | "removedAt">,
  changed: boolean,
): AdminProductWriteResult {
  return { productId, status: updated.status, removedAt: updated.removedAt, changed };
}

/**
 * 列表角标：全部 / 已上架 / 已下架 / 已推荐 / 已移除。
 *
 * ⚠️ 调用方传入的是**全部**记录（含已移除）：
 * - `all` 含已移除，`on` / `off` / `recommended` 只数**未移除**的——
 *   已移除是商品的终态，它既不是上架也不是下架，混进任何一边都会让角标点进去
 *   看到两个不同的集合；
 * - `recommended` 与上下架无关：一件已下架的推荐商品仍然是「推荐过的」，
 *   运营要能按这个筛出来。
 */
export function countAdminProductStates(records: readonly CatalogProductRecord[]): {
  all: number;
  on: number;
  off: number;
  recommended: number;
  removed: number;
} {
  let on = 0;
  let off = 0;
  let recommended = 0;
  let removed = 0;

  for (const record of records) {
    if (record.removedAt !== null) {
      removed += 1;
      continue;
    }
    if (record.status === "on") on += 1;
    else off += 1;
    if (record.recommended) recommended += 1;
  }

  return { all: records.length, on, off, recommended, removed };
}
