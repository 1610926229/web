import type {
  ContentAnnouncementRecord,
  ContentBannerRecord,
  QuickEntryRecord,
} from "@/lib/types/content";

/**
 * 首页运营内容的**预置记录**（图片公告 / 活动 Banner / 快捷入口）。
 *
 * ⚠️ 这里是**仓储的初始数据**，不是用户端数据。建仓时逐字段复制进 store，
 * 之后用户端读的是 store，管理后台改的也是 store。因此「后台改完公告，
 * 用户刷新就是新的」不是任何同步动作做到的——两边读的本来就是同一条记录
 * （与商品目录同一条原理，见 `lib/data/source.ts` 的契约注释）。
 *
 * ⚠️ 为什么从 `./seed.ts` 搬出来：那个文件里剩下的 `homeSeed` 是「首页不随商品变化
 * 的部分」，而这三样从 P8E-1 起**可被后台改动**，生命周期完全不同——
 * 混在一起会让「种子 = 用户端看到的东西」这个已经过时的假设继续被沿用。
 *
 * ⚠️ 时间戳写成**固定字符串**，不用 `daysAgo()` 之类的相对时间：
 * 这三组数据只用于后台列表展示，而固定值让测试里可以直接断言
 * 「这一条是预置的」——相对时间会让同一份数据在不同时刻读出不同的值。
 */

/** 所有预置记录共用的建仓时间。 */
const SEEDED_AT = "2026-01-06T09:00:00.000Z";

/**
 * 图片公告。
 *
 * ⚠️ `title` 是**给后台辨认素材用的**，不进用户端 DTO：公告区只滚动展示图片，
 * 不显示文字、不响应点击（业务口径，见 `lib/types/content.ts`）。
 */
export const announcementSeed: ContentAnnouncementRecord[] = [
  {
    id: "a1",
    title: "首页公告位 - 开工活动",
    imageUrl: "/mock/announcement-1.svg",
    alt: "公告图片占位 1",
    enabled: true,
    sortOrder: 10,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
  },
  {
    id: "a2",
    title: "首页公告位 - 服务时间说明",
    imageUrl: "/mock/announcement-2.svg",
    alt: "公告图片占位 2",
    enabled: true,
    sortOrder: 20,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
  },
];

/**
 * 活动 Banner。
 *
 * ⚠️ 预置只有一条，因为**用户端首页只展示一条**：`selectActivityImageUrl()` 取
 * `enabled` 里排序最前的一条。多条 Banner 是给运营提前备素材用的，
 * 不是让首页变成轮播（§三冻结口径）。
 */
export const bannerSeed: ContentBannerRecord[] = [
  {
    id: "b1",
    title: "首页活动位 - 新客首单",
    imageUrl: "/mock/promo-activity.svg",
    alt: "活动图片占位",
    enabled: true,
    sortOrder: 10,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
  },
];

/**
 * 首页快捷入口（四宫格）。
 *
 * ⚠️ 四个 id 与服务端无关，但与 `QuickEntryIcon` 的取值一一对应是**巧合而不是约定**：
 * 图标由 `icon` 字段决定，`id` 只是主键。因此后台新建的入口可以换任意图标，
 * 也可以有四个都用同一个图标的入口——图标不该被 id 绑住。
 *
 * `path` 必须是以 `/` 开头的站内地址（写入前过 `validateSafePath()`），
 * 且必须指向真实存在的路由——后者由 `tests/routes.test.mjs` 对这份预置数据把关。
 */
export const quickEntrySeed: QuickEntryRecord[] = [
  {
    id: "service",
    label: "联系客服",
    icon: "service",
    path: "/service",
    enabled: true,
    sortOrder: 10,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
  },
  {
    id: "benefits",
    label: "点单权益",
    icon: "benefits",
    path: "/placeholder?title=点单权益",
    enabled: true,
    sortOrder: 20,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
  },
  {
    id: "join",
    label: "考核入驻",
    icon: "join",
    path: "/join",
    enabled: true,
    sortOrder: 30,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
  },
  {
    id: "complaint",
    label: "投诉客服专区",
    icon: "complaint",
    path: "/complaints",
    enabled: true,
    sortOrder: 40,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
  },
];
