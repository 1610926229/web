import type { UserRecord } from "@/lib/data/userRepository";
import type { Addon, Game } from "@/lib/types/catalog";
import type { Companion } from "@/lib/types/companion";
import type { HomeData } from "@/lib/types/content";
import type { Product, ProductDetail } from "@/lib/types/product";

/**
 * Mock 数据种子。
 *
 * ⚠️ 全部为 Mock 数据，仅用于打通取数链路与版式验证：
 * - 图片均为 public/mock 下的本地占位图，待管理端与对象存储就绪后替换；
 * - 商品名称与价格非最终业务数据，不得作为线上文案或定价依据；
 * - 商品名称中不含价格，名称与价格是两个独立字段；价格单位为「分」；
 * - 公告图片内容待管理端上传，此处仅为占位；
 * - 用户为虚构的 Mock 身份，不含 openid 等任何真实微信标识。
 *
 * 商品只有**一份**数据表（`productSeed`）：首页分组与分类页类目都从这里引用，
 * 避免同一商品在两处出现不一致的名称、价格或封面。
 *
 * 接入真实后端后，本目录随 lib/mocks 一并移除。
 */

/**
 * 两个 Mock 用户，用于验证「切换用户后个人信息展示随之变化」。
 *
 * `displayId` 是**平台展示给用户的 ID**（原型资料卡上那一行），形如 UUID 但纯属虚构，
 * 与微信 OpenID / UnionID 没有任何关系——真实身份标识只在服务端保存，不进任何 DTO。
 *
 * `bio` 故意留一个为空：资料卡「暂未填写个人简介」的占位状态要能被验收看到。
 */
export const userSeed: UserRecord[] = [
  {
    id: "u-1001",
    displayId: "3f2a9c14-6b7d-4e58-9c21-8d4f0b7a5e63",
    nickname: "老板A（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    bio: "",
  },
  {
    id: "u-1002",
    displayId: "9c4e1d78-2a53-47f6-b0c8-5e7d3a91f204",
    nickname: "老板B（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    bio: "对局节奏轻一点，谢谢（占位）",
  },
];

/** 游戏与类目。类目内嵌在游戏上，左侧竖栏切换不需要额外请求。 */
export const gameSeed: Game[] = [
  {
    id: "g-delta",
    name: "三角洲行动",
    categories: [
      { id: "c-loss", name: "亏本单" },
      { id: "c-opening", name: "开业特惠" },
      { id: "c-fun", name: "趣味得吃单" },
      { id: "c-speed", name: "一口气打完" },
    ],
    regions: ["手游", "端游"],
  },
  {
    id: "g-valorant",
    name: "无畏契约",
    categories: [
      { id: "c-v-rank", name: "排位护航" },
      { id: "c-v-train", name: "陪练教学" },
    ],
    regions: ["端游"],
  },
];

/**
 * 增值服务目录。
 *
 * ⚠️ 原型结算页没有给出增值服务的价格，这里的名称与价格是**开发阶段的 Mock 规则**，
 * 不是最终业务定价。计费口径：**按单计费，不随购买数量变化**。
 */
export const addonSeed: Addon[] = [
  { id: "ad-rush", name: "加急处理", price: 1500 },
  { id: "ad-voice", name: "全程语音", price: 1000 },
  { id: "ad-insure", name: "掉段保险", price: 2000 },
];

/**
 * 陪玩名单。
 *
 * 其中一位**故意设为不可选**，用于验证「不可用陪玩不能被写入支付请求」；
 * 不可选的陪玩仍会出现在列表里并置灰，不静默隐藏。
 */
export const companionSeed: Companion[] = [
  {
    id: "cp-1",
    name: "阿泽（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    rankLabel: "钻石打手",
    available: true,
  },
  {
    id: "cp-2",
    name: "小北（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    rankLabel: "星耀打手",
    available: true,
  },
  {
    id: "cp-3",
    name: "老K（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    rankLabel: "王者打手",
    available: true,
  },
  {
    id: "cp-4",
    name: "临时工（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    rankLabel: "休息中",
    available: false,
  },
];

/**
 * 目录商品完整记录：详情字段 + 归属关系。
 * 归属（gameId / categoryId）只服务于列表筛选，不进入对外的 `ProductDetail`。
 */
export type CatalogProductRecord = ProductDetail & {
  gameId: string;
  /** 所属类目；`null` 表示不进入任何类目列表，仅供调试用直链访问 */
  categoryId: string | null;
};

const HIDDEN_IMAGE_URL = "/mock/this-image-does-not-exist.svg";

export const productSeed: CatalogProductRecord[] = [
  // —— 三角洲行动 / 亏本单 ——
  {
    id: "p-400w",
    title: "机密400万",
    subtitle: "机密400万",
    coverUrl: "/mock/product-cover-1.svg",
    price: 2990,
    monthlySales: 10029,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-loss",
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
    coverUrl: "/mock/product-cover-2.svg",
    price: 1990,
    monthlySales: 8231,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-loss",
    specs: [
      { id: "s-200w", name: "机密200万", price: 1990 },
      { id: "s-200w-2", name: "机密200万 · 双人", price: 2590 },
    ],
  },
  {
    id: "p-jm200w",
    title: "绝密200万（只打巴克）",
    subtitle: "绝密200万 · 只打巴克",
    coverUrl: "/mock/product-cover-3.svg",
    price: 1990,
    monthlySales: 5602,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-loss",
    specs: [
      { id: "s-jm200w", name: "绝密200万", price: 1990 },
      { id: "s-jm300w", name: "绝密300万", price: 2990 },
    ],
  },
  {
    id: "p-sh300w",
    title: "双护300万（只打巴克）",
    subtitle: "双护300万 · 只打巴克",
    coverUrl: "/mock/product-cover-4.svg",
    price: 2990,
    monthlySales: 3418,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-loss",
    specs: [
      { id: "s-sh300w", name: "双护300万", price: 2990 },
      { id: "s-sh500w", name: "双护500万", price: 4590 },
    ],
  },
  {
    id: "p-150w",
    title: "机密150万",
    subtitle: "入门首选",
    coverUrl: "/mock/product-cover-2.svg",
    price: 1490,
    monthlySales: 1204,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-loss",
    specs: [{ id: "s-150w", name: "机密150万", price: 1490 }],
  },
  {
    id: "p-300w",
    title: "机密300万（限时折扣）",
    subtitle: "机密300万 · 限时折扣",
    coverUrl: "/mock/product-cover-1.svg",
    price: 2490,
    monthlySales: 990,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-loss",
    specs: [
      { id: "s-300w", name: "机密300万", price: 2490 },
      { id: "s-300w-2", name: "机密300万 · 双人", price: 3290 },
    ],
  },
  {
    // 下架商品：不出现在任何列表，直链访问显示下架状态
    id: "p-off-1",
    title: "机密900万（已下架）",
    subtitle: "该商品已下架",
    coverUrl: "/mock/product-cover-1.svg",
    price: 8990,
    monthlySales: 12,
    gameTag: "手游",
    status: "off",
    gameId: "g-delta",
    categoryId: "c-loss",
    specs: [{ id: "s-900w", name: "机密900万", price: 8990 }],
  },

  // —— 三角洲行动 / 开业特惠 ——
  {
    id: "p-600w",
    title: "机密600万",
    subtitle: "机密600万",
    coverUrl: "/mock/product-cover-4.svg",
    price: 3990,
    monthlySales: 2764,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-opening",
    specs: [
      { id: "s-600w", name: "机密600万", price: 3990 },
      { id: "s-600w-2", name: "机密600万 · 双人", price: 5190 },
    ],
  },
  {
    id: "p-500w",
    title: "绝密500万",
    subtitle: "绝密500万",
    coverUrl: "/mock/product-cover-1.svg",
    price: 4990,
    monthlySales: 1893,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-opening",
    specs: [{ id: "s-500w", name: "绝密500万", price: 4990 }],
  },
  {
    id: "p-800w",
    title: "双护800万",
    subtitle: "双护800万",
    coverUrl: "/mock/product-cover-2.svg",
    price: 5990,
    monthlySales: 1102,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-opening",
    specs: [{ id: "s-800w", name: "双护800万", price: 5990 }],
  },
  {
    id: "p-1000w",
    title: "带打1000万",
    subtitle: "带打1000万",
    coverUrl: "/mock/product-cover-3.svg",
    price: 6990,
    monthlySales: 866,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-opening",
    specs: [{ id: "s-1000w", name: "带打1000万", price: 6990 }],
  },
  {
    id: "p-1200w",
    title: "带打1200万（含全程语音陪玩）",
    subtitle: "带打1200万 · 含全程语音",
    coverUrl: "/mock/product-cover-4.svg",
    price: 7990,
    monthlySales: 402,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-opening",
    specs: [{ id: "s-1200w", name: "带打1200万", price: 7990 }],
  },

  // —— 三角洲行动 / 趣味得吃单（含长标题商品）——
  {
    id: "p-fun-1",
    title: "娱乐局随便玩",
    subtitle: "不计不包，纯陪玩",
    coverUrl: "/mock/product-cover-1.svg",
    price: 990,
    monthlySales: 3320,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-fun",
    specs: [{ id: "s-fun-1", name: "娱乐局 1 小时", price: 990 }],
  },
  {
    id: "p-fun-2",
    title: "绝密行动（只打巴克什）三小时极速完成不掉段可全程语音",
    subtitle: "绝密行动 · 三小时速通",
    coverUrl: "/mock/product-cover-3.svg",
    price: 3590,
    monthlySales: 2190,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-fun",
    specs: [
      { id: "s-fun-2a", name: "三小时速通", price: 3590 },
      { id: "s-fun-2b", name: "三小时速通 · 双人", price: 4790 },
    ],
  },
  {
    id: "p-fun-3",
    title: "带飞一局",
    subtitle: "单局体验",
    coverUrl: "/mock/product-cover-2.svg",
    price: 690,
    monthlySales: 5117,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-fun",
    specs: [{ id: "s-fun-3", name: "带飞一局", price: 690 }],
  },
  {
    id: "p-fun-4",
    title: "新手教学陪玩",
    subtitle: "含基础教学",
    coverUrl: "/mock/product-cover-4.svg",
    price: 1290,
    monthlySales: 1425,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-fun",
    specs: [{ id: "s-fun-4", name: "教学陪玩 2 小时", price: 1290 }],
  },
  {
    id: "p-fun-5",
    title: "四人车队整活",
    subtitle: "四人组队娱乐",
    coverUrl: "/mock/product-cover-1.svg",
    price: 1990,
    monthlySales: 733,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-fun",
    specs: [{ id: "s-fun-5", name: "四人车队 1 小时", price: 1990 }],
  },

  // —— 三角洲行动 / 一口气打完 ——
  {
    id: "p-speed-1",
    title: "一口气打完一整套",
    subtitle: "不限时段，打完为止",
    coverUrl: "/mock/product-cover-3.svg",
    price: 12900,
    monthlySales: 208,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-speed",
    specs: [
      { id: "s-speed-1a", name: "标准档", price: 12900 },
      { id: "s-speed-1b", name: "加急档", price: 17900 },
    ],
  },
  {
    id: "p-speed-2",
    title: "全天包时段",
    subtitle: "当日不限局数",
    coverUrl: "/mock/product-cover-1.svg",
    price: 9900,
    monthlySales: 341,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: "c-speed",
    specs: [{ id: "s-speed-2", name: "全天包时段", price: 9900 }],
  },

  // —— 无畏契约 ——
  {
    id: "p-vr-1",
    title: "排位护航（黄金-铂金）",
    subtitle: "不掉段，含复盘",
    coverUrl: "/mock/product-cover-2.svg",
    price: 4590,
    monthlySales: 1567,
    gameTag: "端游",
    status: "on",
    gameId: "g-valorant",
    categoryId: "c-v-rank",
    specs: [
      { id: "s-vr-1a", name: "黄金-铂金", price: 4590 },
      { id: "s-vr-1b", name: "铂金-钻石", price: 6990 },
    ],
  },
  {
    id: "p-vr-2",
    title: "排位护航（钻石-超凡）",
    subtitle: "高分段护航",
    coverUrl: "/mock/product-cover-4.svg",
    price: 9900,
    monthlySales: 623,
    gameTag: "端游",
    status: "on",
    gameId: "g-valorant",
    categoryId: "c-v-rank",
    specs: [{ id: "s-vr-2", name: "钻石-超凡", price: 9900 }],
  },
  {
    id: "p-vr-3",
    title: "定级赛陪打",
    subtitle: "新赛季定级",
    coverUrl: "/mock/product-cover-3.svg",
    price: 3590,
    monthlySales: 1204,
    gameTag: "端游",
    status: "on",
    gameId: "g-valorant",
    categoryId: "c-v-rank",
    specs: [{ id: "s-vr-3", name: "定级赛陪打", price: 3590 }],
  },
  {
    id: "p-vt-1",
    title: "枪法教学",
    subtitle: "一对一复盘",
    coverUrl: "/mock/product-cover-1.svg",
    price: 2590,
    monthlySales: 892,
    gameTag: "端游",
    status: "on",
    gameId: "g-valorant",
    categoryId: "c-v-train",
    specs: [
      { id: "s-vt-1a", name: "枪法教学 1 小时", price: 2590 },
      { id: "s-vt-1b", name: "枪法教学 3 小时", price: 6590 },
    ],
  },
  {
    id: "p-vt-2",
    title: "英雄池扩展指导",
    subtitle: "角色选择与运营",
    coverUrl: "/mock/product-cover-2.svg",
    price: 3290,
    monthlySales: 411,
    gameTag: "端游",
    status: "on",
    gameId: "g-valorant",
    categoryId: "c-v-train",
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
    price: 100,
    monthlySales: 0,
    gameTag: "手游",
    status: "on",
    gameId: "g-delta",
    categoryId: null,
    specs: [{ id: "s-debug", name: "调试规格", price: 100 }],
  },
];

/** 商品记录 → 列表卡片字段。列表不携带规格、月售等详情页字段。 */
export function toCard(record: CatalogProductRecord): Product {
  return {
    id: record.id,
    title: record.title,
    subtitle: record.subtitle,
    coverUrl: record.coverUrl,
    price: record.price,
  };
}

/** 商品记录 → 对外详情。显式挑字段，避免把 Mock 内部字段整体泄漏到接口响应里。 */
export function toDetail(record: CatalogProductRecord): ProductDetail {
  return {
    id: record.id,
    title: record.title,
    subtitle: record.subtitle,
    coverUrl: record.coverUrl,
    price: record.price,
    monthlySales: record.monthlySales,
    gameTag: record.gameTag,
    status: record.status,
    specs: record.specs,
    // 结算页需要据此取大区列表；categoryId 这类只服务于列表筛选的字段仍然不外传
    gameId: record.gameId,
  };
}

function card(id: string): Product {
  const record = productSeed.find((item) => item.id === id);
  if (!record) throw new Error(`Mock 种子缺失商品：${id}`);
  return toCard(record);
}

/**
 * 首页聚合数据。
 *
 * 分组是运营配置的营销编组，与分类页的类目**不是同一套划分**，因此这里显式列出商品 id；
 * 但商品本身只引用 `productSeed`，名称与价格不会出现两份。
 */
export const homeSeed: HomeData = {
  // 公告区：仅图片滚动展示，无跳转字段
  announcements: [
    { id: "a1", imageUrl: "/mock/announcement-1.svg", alt: "公告图片占位 1" },
    { id: "a2", imageUrl: "/mock/announcement-2.svg", alt: "公告图片占位 2" },
  ],

  activityImageUrl: "/mock/promo-activity.svg",

  shortcuts: [
    { id: "service", label: "联系客服", href: "/service" },
    { id: "benefits", label: "点单权益", href: "/placeholder?title=点单权益" },
    { id: "join", label: "考核入驻", href: "/join" },
    { id: "complaint", label: "投诉客服专区", href: "/complaints" },
  ],

  sections: [
    {
      id: "loss",
      title: "亏本单",
      moreHref: "/category",
      products: ["p-400w", "p-200w", "p-jm200w", "p-sh300w"].map(card),
    },
    {
      id: "opening",
      title: "开业特惠",
      moreHref: "/category",
      products: ["p-600w", "p-500w", "p-800w", "p-1000w"].map(card),
    },
  ],
};
