/**
 * 商品相关类型。
 *
 * 金额一律以「分」为单位存整数，展示时经 lib/utils/format.ts 转换（统一两位小数）。
 * 商品名称与价格是相互独立的字段，名称中不得包含价格。
 *
 * ⚠️ **公开 DTO 与内部实体是两组类型**（P8B 起），与 `lib/types/catalog.ts` 同一个理由：
 * 商品从本阶段起由后台管理（有排序、推荐状态、软删除、单组规格的启停），
 * 那些字段属于**运营状态**，不该进用户端 DTO——用户端只需要「这件商品现在长什么样、
 * 能不能买」。
 */

// ——————————————————————————— 公开 DTO ———————————————————————————

/**
 * 商品规格选项（如「机密400万」）。**公开 DTO**，且只包含**有效规格**。
 *
 * ⚠️ 单组规格、单选，暂不支持多属性组合 SKU。
 *
 * 「有效」= `enabled` 且未移除。停用与已移除的规格不进 DTO，因此
 * **结算页根本看不到它们**——「停用规格不能用于新结算」这条规则
 * 不是靠在结算流程里加判断实现的，而是它压根不在可选集合里。
 */
export type ProductSpec = {
  id: string;
  /** 规格名，同时作为下单时的规格快照来源 */
  name: string;
  /** 单位：分。不同规格可以有不同价格 */
  price: number;
};

/**
 * 商品卡片数据（首页、分类页列表使用）。
 *
 * 列表只需要展示所需的字段，**不含规格明细**：规格只在详情页使用，
 * 放进列表类型会让列表接口返回大量用不上的数据。详情类型见 `ProductDetail`。
 */
export type Product = {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  /**
   * 列表展示价格（起售价），单位：分。
   *
   * ⚠️ **算出来的，不是存的**：取有效规格里的最低价。存一个独立的「商品价」字段
   * 迟早会和规格价对不上——改了规格价格、列表还显示旧价，而这种不一致
   * 只会在用户投诉时才被发现。
   */
  price: number;
};

/** 商品状态。下架商品不出现在任何列表里，但可通过直链访问并显示下架状态。 */
export type ProductStatus = "on" | "off";

/** 商品详情：在卡片字段之外，补充详情页独有的展示字段与规格。 */
export type ProductDetail = Product & {
  /** 月售数量，展示时经 abbreviateNumber 缩写。**统计字段，后台不可改** */
  monthlySales: number;
  /** 游戏标签（如「手游」）。平台侧展示标签，后台不可改 */
  gameTag: string;
  status: ProductStatus;
  /** 单组规格，单选；只含有效规格。默认选中第一项 */
  specs: ProductSpec[];
  /** 运营配置的商品标签（如「热门」）。与 `gameTag` 不同：这个由后台维护 */
  tags: string[];
  /** 图文祥情：文字部分 */
  detailText: string;
  /** 图文祥情：图片部分，取自 `/public/mock` 白名单 */
  detailImages: string[];
  /**
   * 所属游戏。
   *
   * 归属信息对列表是内部字段，但结算页需要用它取出该游戏的大区列表并校验用户选择，
   * 因此进入对外的详情类型——它只暴露「这个商品属于哪个游戏」，不含任何筛选用的内部状态。
   */
  gameId: string;
};

// ——————————————————————————— 内部实体 ———————————————————————————

/**
 * 规格记录（内部实体）。
 *
 * `id` 是**稳定身份**：后台改价、改名、调序、启停都只改字段，
 * 绝不重新生成 id，也绝不把「第几项」当身份。
 * 用数组下标当身份的话，删掉中间一项就会让后面所有项的身份错位——
 * 而订单快照里记的正是这个 id。
 */
export type ProductSpecRecord = {
  id: string;
  name: string;
  /** 单位：分。**只允许整数**，元 → 分的转换在 `lib/constants/adminProducts.ts` */
  price: number;
  /** 组内展示排序。升序，相同则按 id 兜底 */
  sortOrder: number;
  /** 停用后不能用于新结算；已下单的历史订单不受影响（它们读的是快照） */
  enabled: boolean;
  /** 软删除时间；`null` 表示未移除 */
  removedAt: string | null;
};

/**
 * 目录商品完整记录（内部实体）：详情字段 + 归属关系 + 运营状态。
 *
 * ⚠️ 这里**没有 `price`**：商品的展示价格由有效规格算出（见 `Product.price`）。
 * ⚠️ 这里**没有库存、限购**字段：本阶段不做这两件事，留一个「先填个 0」的字段
 * 只会让人以为它已经在生效。
 */
export type CatalogProductRecord = {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  /** 所属游戏 */
  gameId: string;
  /** 所属类目；`null` 表示不进入任何类目列表，仅供调试用直链访问 */
  categoryId: string | null;
  tags: string[];
  detailText: string;
  detailImages: string[];
  sortOrder: number;
  /** 推荐状态。只影响后台标记与列表展示，不改变用户端排序规则 */
  recommended: boolean;
  status: ProductStatus;
  /** 月售。**统计字段，后台不可改**（见 `lib/constants/adminProducts.ts` 的白名单） */
  monthlySales: number;
  /** 平台侧展示标签。**后台不可改** */
  gameTag: string;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  specs: ProductSpecRecord[];
};

// ——————————————————————————— 管理端 ———————————————————————————

/** 管理端商品列表项 / 详情。**显式挑字段**，统计与内部字段按需给出，实体不外流。 */
export type AdminProductListItem = {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  gameId: string;
  gameName: string;
  categoryId: string | null;
  categoryName: string;
  tags: string[];
  detailText: string;
  detailImages: string[];
  sortOrder: number;
  recommended: boolean;
  status: ProductStatus;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 有效规格数（启用且未移除） */
  effectiveSpecCount: number;
  /** 全部规格数（含停用与已移除） */
  specCount: number;
  /** 起售价，单位：分；由有效规格算出 */
  priceFrom: number;
  /** 月售。**只读统计**，后台改不了 */
  monthlySales: number;
  /** 平台展示标签。**只读** */
  gameTag: string;
  /** 全部规格（含停用与已移除）——后台要能看见并管理它们 */
  specs: ProductSpecRecord[];
};

/**
 * 类目选项（管理端）。
 *
 * ⚠️ 带 `enabled` 与 `removedAt`：一条既有商品的类目有可能在它上架之后被停用，
 * 表单必须能把它**显示出来**并说明「这个类目已经不能用了」，
 * 而不是让选择器变成一个空的、看起来像数据丢了的控件。
 */
export type AdminProductCategoryOption = {
  id: string;
  name: string;
  gameId: string;
  enabled: boolean;
  removedAt: string | null;
};

/** 一页商品 + 筛选栏选项 + 各状态角标。页面首屏与接口返回的是同一个形状。 */
export type AdminProductListData = {
  items: AdminProductListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  games: { id: string; name: string }[];
  /**
   * 筛选栏的类目选项。**含停用与已移除**，与列表里能看到的商品保持一致——
   * 筛选栏里少一个选项，就会让「带着 categoryId 打开这一页」变成
   * 一个显示着「全部类目」却只列出几条商品的筛选器。
   */
  categories: AdminProductCategoryOption[];
  /**
   * 列表角标。
   *
   * ⚠️ 四个数**加起来等于 `all`**（`all` 含已移除的一条）：已移除是商品的一个终态，
   * 既不是上架也不是下架。把它混进「已下架」，点进去会看到两个不同的集合。
   */
  counts: { all: number; on: number; off: number; recommended: number; removed: number };
  notice: string;
};

/**
 * 商品表单要用的选项集合（服务端取数、作为 props 交给客户端表单组件）。
 *
 * ⚠️ `categories` 给的是**全部**类目（含停用与已移除），不是「可选的类目」：
 * 一条既有商品的类目有可能在它上架之后被停用，表单必须能把它**显示出来**、
 * 并且明确告诉运营「这个类目已经不能用了」，而不是让选择器变成一个空的、
 * 看起来像数据丢了的控件。
 */
export type AdminProductFormOptions = {
  games: { id: string; name: string }[];
  categories: AdminProductCategoryOption[];
  /** 封面白名单（`public/mock` 下的商品图） */
  coverOptions: string[];
  /** 图文详情图片白名单 */
  detailImageOptions: string[];
};

/** 写操作的返回：界面据此就地更新那一行，不必为了刷新一个开关重拉整页。 */
export type AdminProductWriteResult = {
  productId: string;
  status: ProductStatus;
  removedAt: string | null;
  changed: boolean;
};

/**
 * 规格入参（**原始输入**，价格是用户在界面上敲的「元」字符串）。
 *
 * 这也是界面与服务端之间的**线上形状**（`ProductProfilePatch.specs`）：表单填什么就传什么。
 * 客户端只能表达「元」，转成整数分的能力**只在服务端**（`toProductDraft()`）——
 * 于是 §商品规则 的「金额只以整数分进入实体」不是靠界面自觉，而是结构上做不到。
 *
 * `id` 为空串表示**新增**；非空必须是该商品已有的规格 id——认不出来的 id 会被拒绝，
 * 而不是当成新规格，否则一个手误就会静默多出一条重复规格。
 *
 * ⚠️ `removed` 是**软删除意图**：规格从不被物理删除（订单快照里记着它的 id），
 * 勾上它只是把 `removedAt` 写上一个时间。行保留在表单里、标成「已移除」，
 * 因此「删错了」在保存之前还能撤销。
 */
export type ProductSpecInput = {
  id: string;
  name: string;
  /** 界面输入的是元（如 `29.90`），服务端严格转成整数分 */
  priceYuan: string;
  sortOrder: number;
  enabled: boolean;
  removed: boolean;
};

/**
 * 规格的**服务端内部草稿**形状：价格已是整数分。这是写进实体的形状。
 *
 * ⚠️ 它**不是**线上格式。界面与服务端之间传的是 `ProductSpecInput`（元文本），
 * 元转分只发生在服务端 `toProductDraft()` 里。两个类型长得很像但差一个字段名
 * （`price` 分 vs `priceYuan` 元），混用的后果是金额被判成非法。
 */
export type AdminProductSpecPatch = {
  id: string;
  name: string;
  /** 单位：分，整数 */
  price: number;
  sortOrder: number;
  enabled: boolean;
  /** 是否要求软删除该规格 */
  removed: boolean;
};

/**
 * 商品编辑白名单 —— 后台能改的字段就是这些，多一个都没有。
 *
 * ⚠️ **不在这个类型里**的字段：`monthlySales`（销量）、`gameTag`、
 * `createdAt`、`updatedAt`、`removedAt`、`id`。客户端多传一个不会有任何效果，
 * 因为服务层**根本没有读取它们的位置**（§九：客户端伪造 ID、状态、时间、销量、
 * 统计字段必须被忽略）。
 *
 * 规格与商品**一起写**：`specs` 是这份 patch 的一部分，因此一次保存
 * 要么商品与规格一起生效，要么一起不生效（§原子性）。
 */
export type ProductProfilePatch = {
  gameId: string;
  categoryId: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  tags: string[];
  detailText: string;
  detailImages: string[];
  sortOrder: number;
  recommended: boolean;
  status: ProductStatus;
  /**
   * ⚠️ 线上传的是**元**文本（`ProductSpecInput`），不是分。
   *
   * 这里曾经写的是 `AdminProductSpecPatch`（`price`，分），而服务端
   * `readSpecInputs()` 读的是 `priceYuan`：字段名对不上，缺的键又被
   * `readTrimmedString()` 兜成空串，于是界面上填的 `10` 元在服务端变成
   * `parsePriceYuanToFen("") === null`，报「单价必须大于 0，最多两位小数…」，
   * 商品建不出来。服务端要的是元的十进制文本，类型就必须是元。
   */
  specs: ProductSpecInput[];
};

/**
 * 商品草稿（**服务端内部**）：在 `ProductProfilePatch` 之上把规格金额换成整数分。
 *
 * 由服务端的 `toProductDraft()` 产出，直接交给原子写入。它不出现在任何线上契约里。
 */
export type ProductProfileDraft = Omit<ProductProfilePatch, "specs"> & {
  specs: AdminProductSpecPatch[];
};
