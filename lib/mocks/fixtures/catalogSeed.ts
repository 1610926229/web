import { DEFAULT_COMPANION_RATE_BP } from "@/lib/constants/shareRatio";
import type { Addon, CategoryRecord, GameRecord } from "@/lib/types/catalog";
import type { HomeSectionSeed } from "@/lib/types/content";
import type {
  CatalogProductRecord,
  ProductSpecRecord,
  ProductStatus,
} from "@/lib/types/product";
import { getMockSeedNow } from "./mockClock";

/**
 * 目录种子：**游戏、类目、增值服务、商品、首页分组**。
 *
 * ⚠️ 全部为 Mock 数据，仅用于打通取数链路与版式验证：
 * - 图片均为 `public/mock` 下的本地占位图（后台上架时也只能从这份白名单里选）；
 * - 商品名称与价格非最终业务数据，不得作为线上文案或定价依据；
 * - 商品名称中不含价格——名称与价格是两个独立字段，价格单位为「分」；
 * - 没有任何库存、限购、多属性组合 SKU 字段：本阶段不做这三件事，
 *   留一个「先填个 0」的字段只会让人以为它已经在生效。
 *
 * ⚠️ **这份种子只是初始值**（P8B 起）：进程启动时被逐字段复制进唯一的目录仓储
 * （`lib/data/mockCatalogRepository.ts`），之后后台的每一次改名、改图、改价、
 * 上下架都发生在仓储里，**不会再读写这里的常量**。重启开发服务器即回到这份种子。
 *
 * 数据表仍然只有**一份**：首页分组、分类页类目、商品详情、结算页与后台读的是
 * 同一个仓储，因此同一条商品在哪一处都不会出现两个名称或两个价格。
 * 接入真实后端后，本目录随 `lib/mocks` 一并移除。
 */

// ——————————————————————————— 游戏 ———————————————————————————

/**
 * 游戏目录。
 *
 * ⚠️ 游戏**不由后台管理**（P8B 明确不做游戏管理），因此这里没有启用状态与排序，
 * 它就是一份只读目录；类目通过 `gameId` 依附在它上面。
 * 类型从 `Game`（公开 DTO，类目内嵌）换成 `GameRecord`：类目现在是独立记录表，
 * 内嵌一份进去就会有两个地方说得清「这个类目属于谁」。
 */
export const gameSeed: GameRecord[] = [
  { id: "g-delta", name: "三角洲行动", regions: ["手游", "端游"] },
  { id: "g-valorant", name: "无畏契约", regions: ["端游"] },
];

// ——————————————————————————— 类目 ———————————————————————————

const SEED_NOW_MS = getMockSeedNow().getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

/** 种子记录的时间戳：相对基准时间往前推若干天，避免所有记录的时间一模一样。 */
function seedDaysAgo(days: number): string {
  return new Date(SEED_NOW_MS - days * DAY_MS).toISOString();
}

/** 商品与类目共用的建表时间：预置数据是一次建出来的。 */
const SEED_CREATED_AT = seedDaysAgo(60);

/**
 * 类目表。
 *
 * `sortOrder` 用 10 / 20 / 30 …（步长 10）：往后要往两项之间插一条时不必重排整张表，
 * 这是「排序」这种字段最常见的用法，也是后台里两条记录排到同一个值时仍然
 * 能靠 id 兜底排稳的前提。
 *
 * 所有预置类目都是**启用且未移除**的：一上来就摆几条停用 / 已移除的类目，
 * 「停用类目不出现在用户端导航」这个状态就没有一个干净的对照可看，
 * 后台「已移除」筛选也永远看不到空态。要验证就自己停用一条——那是几秒钟的事。
 */
export const categorySeed: CategoryRecord[] = [
  { id: "c-loss", gameId: "g-delta", name: "亏本单", sortOrder: 10 },
  { id: "c-opening", gameId: "g-delta", name: "开业特惠", sortOrder: 20 },
  { id: "c-fun", gameId: "g-delta", name: "趣味得吃单", sortOrder: 30 },
  { id: "c-speed", gameId: "g-delta", name: "一口气打完", sortOrder: 40 },
  { id: "c-v-rank", gameId: "g-valorant", name: "排位护航", sortOrder: 10 },
  { id: "c-v-train", gameId: "g-valorant", name: "陪练教学", sortOrder: 20 },
].map((input) => ({
  ...input,
  enabled: true,
  createdAt: SEED_CREATED_AT,
  updatedAt: SEED_CREATED_AT,
  removedAt: null,
}));

// ——————————————————————————— 增值服务 ———————————————————————————

/**
 * 增值服务目录。
 *
 * ⚠️ 原型结算页没有给出增值服务的价格，这里的名称与价格是**开发阶段的 Mock 规则**，
 * 不是最终业务定价。计费口径：**按单计费，不随购买数量变化**。
 * 本阶段增值服务**不进后台**（§不做 里没有它），因此这里是一份只读目录。
 */
export const addonSeed: Addon[] = [
  { id: "ad-rush", name: "加急处理", price: 1500 },
  { id: "ad-voice", name: "全程语音", price: 1000 },
  { id: "ad-insure", name: "掉段保险", price: 2000 },
];

// ——————————————————————————— 商品 ———————————————————————————

/**
 * 种子里的规格输入。
 *
 * 只写「稳定 id / 名称 / 价格（分）」三样，其余三项由 `buildProducts()` 统一生成：
 * - `sortOrder` = 组内下标 × 10（与类目同一套步长）；
 * - `enabled` = true、`removedAt` = null（理由同上面的类目：预置数据不留停用态）。
 */
type SpecSeed = { id: string; name: string; price: number };

/**
 * 种子里的商品输入。
 *
 * ⚠️ 这里**没有 `price`**：商品的展示价由有效规格算出（取最低价），
 * 存一个独立的「商品价」字段迟早会和规格价对不上。原来的种子每条都写了一遍
 * `price`，而它恰好都等于 `min(规格价)`——那正说明它是冗余的。
 */
type ProductSeed = {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  gameId: string;
  /** `null` = 不进入任何类目列表（调试用直链） */
  categoryId: string | null;
  /** 缺省为 `"on"`；只有刻意下架的那一条写 `"off"` */
  status?: ProductStatus;
  monthlySales: number;
  gameTag: string;
  /** 缺省为 false */
  recommended?: boolean;
  /** 缺省为空数组 */
  tags?: string[];
  detailText: string;
  /** 缺省为「本商品封面 + 活动图」 */
  detailImages?: string[];
  /**
   * 分账比例（基点，8000 = 80%）。
   *
   * 缺省为 `DEFAULT_COMPANION_RATE_BP`（80%）：预置商品全部用同一个比例，
   * 「按商品分别配置」这件事由后台改价那一刻起才真正开始（P0-3 的商品管理表单）。
   * 单位是基点而不是百分比，与实体一致——种子写的是**存储值**，不是界面值。
   */
  companionRateBp?: number;
  specs: SpecSeed[];
};

/** 封面白名单里的四张图，顺序与原型里的四张商品图一致。 */
const COVER_1 = "/mock/product-cover-1.svg";
const COVER_2 = "/mock/product-cover-2.svg";
const COVER_3 = "/mock/product-cover-3.svg";
const COVER_4 = "/mock/product-cover-4.svg";
const PROMO_IMAGE = "/mock/promo-activity.svg";

/** 封面是刻意写错的调试商品用的地址（验证「主图加载失败」占位）。 */
const HIDDEN_IMAGE_URL = "/mock/this-image-does-not-exist.svg";

const PRODUCT_SEEDS: ProductSeed[] = [
  // —— 三角洲行动 / 亏本单 ——
  {
    id: "p-400w",
    title: "机密400万",
    subtitle: "机密400万",
    coverUrl: COVER_1,
    gameId: "g-delta",
    categoryId: "c-loss",
    monthlySales: 10029,
    gameTag: "手游",
    recommended: true,
    tags: ["热门", "稳定交付"],
    detailText:
      "机密行动打包完成，全程不换人；掉线重连的时间也算在服务里。下单后可在大区备注里写清时间段。",
    specs: [
      { id: "s-400w", name: "机密400万", price: 2990 },
      { id: "s-400w-2", name: "机密400万 · 双人", price: 3990 },
      { id: "s-400w-3", name: "机密400万 · 三小时速通", price: 4590 },
    ],
  },
  {
    id: "p-200w",
    title: "机密200万",
    subtitle: "机密200万！",
    coverUrl: COVER_2,
    gameId: "g-delta",
    categoryId: "c-loss",
    monthlySales: 8231,
    gameTag: "手游",
    tags: ["热门"],
    detailText: "入门档机密单，适合先试一次节奏。单人档与双人档价格不同，按需选择。",
    specs: [
      { id: "s-200w", name: "机密200万", price: 1990 },
      { id: "s-200w-2", name: "机密200万 · 双人", price: 2590 },
    ],
  },
  {
    id: "p-jm200w",
    title: "绝密200万（只打巴克）",
    subtitle: "绝密200万 · 只打巴克",
    coverUrl: COVER_3,
    gameId: "g-delta",
    categoryId: "c-loss",
    monthlySales: 5602,
    gameTag: "手游",
    tags: ["只打巴克什"],
    detailText: "只在巴克什地图完成，不接其它地图。绝密档位越高掉段风险越大，请自行评估。",
    specs: [
      { id: "s-jm200w", name: "绝密200万", price: 1990 },
      { id: "s-jm300w", name: "绝密300万", price: 2990 },
    ],
  },
  {
    id: "p-sh300w",
    title: "双护300万（只打巴克）",
    subtitle: "双护300万 · 只打巴克",
    coverUrl: COVER_4,
    gameId: "g-delta",
    categoryId: "c-loss",
    monthlySales: 3418,
    gameTag: "手游",
    tags: ["双人护航"],
    detailText: "双护航同时进场，适合需要稳定推进的老板。同样只接巴克什地图。",
    specs: [
      { id: "s-sh300w", name: "双护300万", price: 2990 },
      { id: "s-sh500w", name: "双护500万", price: 4590 },
    ],
  },
  {
    id: "p-150w",
    title: "机密150万",
    subtitle: "入门首选",
    coverUrl: COVER_2,
    gameId: "g-delta",
    categoryId: "c-loss",
    monthlySales: 1204,
    gameTag: "手游",
    detailText: "最低门槛的机密档，想先看看手感可以从这一档开始。",
    specs: [{ id: "s-150w", name: "机密150万", price: 1490 }],
  },
  {
    id: "p-300w",
    title: "机密300万（限时折扣）",
    subtitle: "机密300万 · 限时折扣",
    coverUrl: COVER_1,
    gameId: "g-delta",
    categoryId: "c-loss",
    monthlySales: 990,
    gameTag: "手游",
    tags: ["限时"],
    detailText: "折扣档位会随活动结束调整价格，下单时的价格以支付页为准。",
    specs: [
      { id: "s-300w", name: "机密300万", price: 2490 },
      { id: "s-300w-2", name: "机密300万 · 双人", price: 3290 },
    ],
  },
  {
    // 下架商品：不出现在任何列表里，直链访问显示下架状态，且不能结算
    id: "p-off-1",
    title: "机密900万（已下架）",
    subtitle: "该商品已下架",
    coverUrl: COVER_1,
    gameId: "g-delta",
    categoryId: "c-loss",
    status: "off",
    monthlySales: 12,
    gameTag: "手游",
    detailText: "该商品已下架，历史订单与售后不受影响；重新上架后本页会恢复正常下单。",
    specs: [{ id: "s-900w", name: "机密900万", price: 8990 }],
  },

  // —— 三角洲行动 / 开业特惠 ——
  {
    id: "p-600w",
    title: "机密600万",
    subtitle: "机密600万",
    coverUrl: COVER_4,
    gameId: "g-delta",
    categoryId: "c-opening",
    monthlySales: 2764,
    gameTag: "手游",
    recommended: true,
    tags: ["开业特惠"],
    detailText: "开业档位，档期集中在下午到凌晨；具体时间可以在下单后与护航确认。",
    specs: [
      { id: "s-600w", name: "机密600万", price: 3990 },
      { id: "s-600w-2", name: "机密600万 · 双人", price: 5190 },
    ],
  },
  {
    id: "p-500w",
    title: "绝密500万",
    subtitle: "绝密500万",
    coverUrl: COVER_1,
    gameId: "g-delta",
    categoryId: "c-opening",
    monthlySales: 1893,
    gameTag: "手游",
    detailText: "绝密档位对局时间较长，建议预留完整的一个晚上。",
    specs: [{ id: "s-500w", name: "绝密500万", price: 4990 }],
  },
  {
    id: "p-800w",
    title: "双护800万",
    subtitle: "双护800万",
    coverUrl: COVER_2,
    gameId: "g-delta",
    categoryId: "c-opening",
    monthlySales: 1102,
    gameTag: "手游",
    tags: ["双人护航"],
    detailText: "双护航档位，两位护航同时在线，适合需要快速推进的大额单。",
    specs: [{ id: "s-800w", name: "双护800万", price: 5990 }],
  },
  {
    id: "p-1000w",
    title: "带打1000万",
    subtitle: "带打1000万",
    coverUrl: COVER_3,
    gameId: "g-delta",
    categoryId: "c-opening",
    monthlySales: 866,
    gameTag: "手游",
    detailText: "带打档位，护航全程带节奏，适合想同时学思路的老板。",
    specs: [{ id: "s-1000w", name: "带打1000万", price: 6990 }],
  },
  {
    id: "p-1200w",
    title: "带打1200万（含全程语音陪玩）",
    subtitle: "带打1200万 · 含全程语音",
    coverUrl: COVER_4,
    gameId: "g-delta",
    categoryId: "c-opening",
    monthlySales: 402,
    gameTag: "手游",
    tags: ["含语音", "大额单"],
    detailText: "包含全程语音，护航会边打边讲思路。需要安静环境的老板请提前说明。",
    specs: [{ id: "s-1200w", name: "带打1200万", price: 7990 }],
  },

  // —— 三角洲行动 / 趣味得吃单（含长标题商品）——
  {
    id: "p-fun-1",
    title: "娱乐局随便玩",
    subtitle: "不计不包，纯陪玩",
    coverUrl: COVER_1,
    gameId: "g-delta",
    categoryId: "c-fun",
    monthlySales: 3320,
    gameTag: "手游",
    tags: ["纯陪玩"],
    detailText: "不承诺战绩也不计盈亏，就是一起玩。适合下班后放松。",
    specs: [{ id: "s-fun-1", name: "娱乐局 1 小时", price: 990 }],
  },
  {
    id: "p-fun-2",
    title: "绝密行动（只打巴克什）三小时极速完成不掉段可全程语音",
    subtitle: "绝密行动 · 三小时速通",
    coverUrl: COVER_3,
    gameId: "g-delta",
    categoryId: "c-fun",
    monthlySales: 2190,
    gameTag: "手游",
    tags: ["超长标题", "含语音"],
    detailText:
      "超长标题用于验证列表卡片与详情页的换行与截断。实际服务内容以规格与说明为准。",
    specs: [
      { id: "s-fun-2a", name: "三小时速通", price: 3590 },
      { id: "s-fun-2b", name: "三小时速通 · 双人", price: 4790 },
    ],
  },
  {
    id: "p-fun-3",
    title: "带飞一局",
    subtitle: "单局体验",
    coverUrl: COVER_2,
    gameId: "g-delta",
    categoryId: "c-fun",
    monthlySales: 5117,
    gameTag: "手游",
    recommended: true,
    tags: ["新手友好", "单价最低"],
    detailText: "单局体验档，想先试一位护航的手感就拍这一档。",
    specs: [{ id: "s-fun-3", name: "带飞一局", price: 690 }],
  },
  {
    id: "p-fun-4",
    title: "新手教学陪玩",
    subtitle: "含基础教学",
    coverUrl: COVER_4,
    gameId: "g-delta",
    categoryId: "c-fun",
    monthlySales: 1425,
    gameTag: "手游",
    tags: ["新手友好", "含教学"],
    detailText: "以教学为主：地图要点、装备取舍、听声辨位都会讲到，不追求单局收益。",
    specs: [{ id: "s-fun-4", name: "教学陪玩 2 小时", price: 1290 }],
  },
  {
    id: "p-fun-5",
    title: "四人车队整活",
    subtitle: "四人组队娱乐",
    coverUrl: COVER_1,
    gameId: "g-delta",
    categoryId: "c-fun",
    monthlySales: 733,
    gameTag: "手游",
    detailText: "四人车队档，适合朋友一起下单；人数不足时按实际人数折算时长。",
    specs: [{ id: "s-fun-5", name: "四人车队 1 小时", price: 1990 }],
  },

  // —— 三角洲行动 / 一口气打完 ——
  {
    id: "p-speed-1",
    title: "一口气打完一整套",
    subtitle: "不限时段，打完为止",
    coverUrl: COVER_3,
    gameId: "g-delta",
    categoryId: "c-speed",
    monthlySales: 208,
    gameTag: "手游",
    tags: ["大额单"],
    detailText: "不限时段，打到目标为止。加急档会优先排期，价格更高。",
    specs: [
      { id: "s-speed-1a", name: "标准档", price: 12900 },
      { id: "s-speed-1b", name: "加急档", price: 17900 },
    ],
  },
  {
    id: "p-speed-2",
    title: "全天包时段",
    subtitle: "当日不限局数",
    coverUrl: COVER_1,
    gameId: "g-delta",
    categoryId: "c-speed",
    monthlySales: 341,
    gameTag: "手游",
    detailText: "当日不限局数，护航整天在线；跨天不延续，请确认好时间再下单。",
    specs: [{ id: "s-speed-2", name: "全天包时段", price: 9900 }],
  },

  // —— 无畏契约 ——
  {
    id: "p-vr-1",
    title: "排位护航（黄金-铂金）",
    subtitle: "不掉段，含复盘",
    coverUrl: COVER_2,
    gameId: "g-valorant",
    categoryId: "c-v-rank",
    monthlySales: 1567,
    gameTag: "端游",
    recommended: true,
    tags: ["含复盘"],
    detailText: "打完给一段复盘，讲清这一局输赢的原因。掉段由护航负责补回。",
    specs: [
      { id: "s-vr-1a", name: "黄金-铂金", price: 4590 },
      { id: "s-vr-1b", name: "铂金-钻石", price: 6990 },
    ],
  },
  {
    id: "p-vr-2",
    title: "排位护航（钻石-超凡）",
    subtitle: "高分段护航",
    coverUrl: COVER_4,
    gameId: "g-valorant",
    categoryId: "c-v-rank",
    monthlySales: 623,
    gameTag: "端游",
    detailText: "高分段档位，接单前需要先确认账号情况。",
    specs: [{ id: "s-vr-2", name: "钻石-超凡", price: 9900 }],
  },
  {
    id: "p-vr-3",
    title: "定级赛陪打",
    subtitle: "新赛季定级",
    coverUrl: COVER_3,
    gameId: "g-valorant",
    categoryId: "c-v-rank",
    monthlySales: 1204,
    gameTag: "端游",
    detailText: "新赛季定级赛陪打，目标是尽量把定级打到一个能接受的位置。",
    specs: [{ id: "s-vr-3", name: "定级赛陪打", price: 3590 }],
  },
  {
    id: "p-vt-1",
    title: "枪法教学",
    subtitle: "一对一复盘",
    coverUrl: COVER_1,
    gameId: "g-valorant",
    categoryId: "c-v-train",
    monthlySales: 892,
    gameTag: "端游",
    tags: ["含教学"],
    detailText: "一对一：先看录像找问题，再进训练场逐项调整。三小时档包含一次录像复盘。",
    specs: [
      { id: "s-vt-1a", name: "枪法教学 1 小时", price: 2590 },
      { id: "s-vt-1b", name: "枪法教学 3 小时", price: 6590 },
    ],
  },
  {
    id: "p-vt-2",
    title: "英雄池扩展指导",
    subtitle: "角色选择与运营",
    coverUrl: COVER_2,
    gameId: "g-valorant",
    categoryId: "c-v-train",
    monthlySales: 411,
    gameTag: "端游",
    tags: ["含教学"],
    detailText: "从角色池与地图搭配讲起，帮你在排位里找到能稳定拿出来的角色。",
    specs: [{ id: "s-vt-2", name: "英雄池指导 2 小时", price: 3290 }],
  },

  // —— 调试专用（categoryId 为 null，不进任何类目列表）——
  {
    // 仅用于验证「商品主图加载失败」占位：封面地址是刻意写错的，
    // 正常演示页面不会出现这个商品，只能通过 /product/p-debug-broken-image 直链访问。
    id: "p-debug-broken-image",
    title: "调试用商品（封面加载失败）",
    subtitle: "仅用于验证图片失败占位",
    coverUrl: HIDDEN_IMAGE_URL,
    gameId: "g-delta",
    categoryId: null,
    monthlySales: 0,
    gameTag: "手游",
    detailText: "该商品的封面地址是刻意写错的，用于验证图片加载失败时的占位表现。",
    // 这张商品自己的封面是坏的，图文详情里就不再放它，免得同一个坏图出现两次
    detailImages: [PROMO_IMAGE],
    specs: [{ id: "s-debug", name: "调试规格", price: 100 }],
  },
];

/**
 * 种子输入 → 商品记录。
 *
 * 三个默认值在这里一次定好，25 条记录就不必各写一遍：
 * - `specs` 的 `sortOrder` / `enabled` / `removedAt`；
 * - `detailImages` 缺省为「本商品封面 + 活动图」（活动图是白名单里唯一一张非封面图）；
 * - `status` 缺省为上架、`recommended` 缺省为 false、`tags` 缺省为空。
 *
 * `sortOrder` 取「数组下标 × 10」：这与原来「列表按种子顺序展示」的结果**完全一致**，
 * 因此引入排序字段不会让任何一个既有列表的先后发生变化。
 */
function buildProducts(seeds: readonly ProductSeed[]): CatalogProductRecord[] {
  return seeds.map((seed, index) => ({
    id: seed.id,
    title: seed.title,
    subtitle: seed.subtitle,
    coverUrl: seed.coverUrl,
    gameId: seed.gameId,
    categoryId: seed.categoryId,
    tags: [...(seed.tags ?? [])],
    detailText: seed.detailText,
    detailImages: [...(seed.detailImages ?? [seed.coverUrl, PROMO_IMAGE])],
    sortOrder: (index + 1) * 10,
    recommended: seed.recommended ?? false,
    status: seed.status ?? "on",
    monthlySales: seed.monthlySales,
    gameTag: seed.gameTag,
    // 分账比例：缺省 80%。**这一处是唯一的默认值落点**——
    // 不在别处再写一遍 `?? 8000`，也不让任何商品缺字段
    companionRateBp: seed.companionRateBp ?? DEFAULT_COMPANION_RATE_BP,
    // 建表时间按数组下标往前错开，后台列表的「更新时间」因此有先后可看
    createdAt: SEED_CREATED_AT,
    updatedAt: seedDaysAgo(index % 30),
    removedAt: null,
    specs: seed.specs.map(
      (spec, specIndex): ProductSpecRecord => ({
        id: spec.id,
        name: spec.name,
        price: spec.price,
        sortOrder: (specIndex + 1) * 10,
        enabled: true,
        removedAt: null,
      }),
    ),
  }));
}

export const productSeed: CatalogProductRecord[] = buildProducts(PRODUCT_SEEDS);

// ——————————————————————————— 首页分组 ———————————————————————————

/**
 * 首页商品分组。
 *
 * 分组是运营配置的营销编组，与分类页的类目**不是同一套划分**，因此这里显式列出商品 id；
 * 但存的是 **id**，商品本身在每次请求时从目录仓储现取——后台下架或软删除某件商品之后，
 * 首页当晚还在推它，是那种必须靠人偶然比对才能发现的事故。
 */
export const homeSectionSeed: HomeSectionSeed[] = [
  {
    id: "loss",
    title: "亏本单",
    moreHref: "/category",
    productIds: ["p-400w", "p-200w", "p-jm200w", "p-sh300w"],
  },
  {
    id: "opening",
    title: "开业特惠",
    moreHref: "/category",
    productIds: ["p-600w", "p-500w", "p-800w", "p-1000w"],
  },
];
