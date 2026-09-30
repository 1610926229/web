/**
 * 首页运营内容类型：图片公告 / 活动 Banner / 快捷入口。
 *
 * ⚠️ **三套类型，一套数据**（P8E-1 起）。与商品目录（`lib/types/catalog.ts`）同一套分层：
 *
 * - **用户端 DTO**（`AnnouncementImage` / `HomeShortcut`）：页面真正渲染的形状。
 *   刻意窄——公告没有标题、没有跳转字段；快捷入口的 `href` 已经过安全校验。
 * - **内部实体**（`ContentAnnouncementRecord` / `ContentBannerRecord` / `QuickEntryRecord`）：
 *   仓储里存的东西，含 `enabled` / `sortOrder` / 软删除 / 时间戳，这些用户端一个都看不到。
 * - **管理端 DTO**（`AdminAnnouncementItem` / …）：后台列表与表单用的形状，显式挑字段。
 *
 * 为什么必须分开而不是共用一个类型：共用的话，「用户端永远不该看到停用中的素材」
 * 这条规则就只能靠每个调用点自己记得过滤——漏掉一处，用户端就会多出一条后台刚停用的公告，
 * 而这种漏法在代码评审里几乎看不出来。分成两套之后，用户端 DTO 里**根本没有** `enabled`
 * 这个字段，能把它渲染出去的那种代码写不出来。
 */
import type { Product } from "./product";

/**
 * 公告图片。
 *
 * ⚠️ 公告区仅做图片滚动展示，**不含跳转字段、不响应点击**（业务口径，不是还没做）。
 * 因此这里没有 `href` / `link` / `path`，将来也不会因为「顺手」加上。
 * 后台可以在记录上填一个 `title` 用于自己辨认，但那个字段**不进这个 DTO**。
 */
export type AnnouncementImage = {
  id: string;
  imageUrl: string;
  alt: string;
};

/**
 * 快捷入口的图标。
 *
 * ⚠️ **固定枚举**，不是图片地址。本阶段不做图片上传（§三），图标只能从内置的几个
 * 图形里选一个，由 `components/home/HomeShortcutGrid.tsx` 映射成内置 SVG。
 * 存 URL 的话，后台把一个外域地址填进来就等于让用户端加载任意站外资源。
 */
export type QuickEntryIcon = "service" | "benefits" | "join" | "complaint";

/**
 * 首页快捷入口。
 *
 * ⚠️ 字段名是 `href`（用户端的叫法），仓储里那条记录叫 `path`（后台表单的叫法）。
 * 两者由 `toHomeShortcut()` 一处转换，转换时**已经过 `validateSafePath()`**——
 * 因此页面拿到的 `href` 可以直接放进 `<Link>`，不必在渲染期再判一次。
 */
export type HomeShortcut = {
  id: string;
  label: string;
  href: string;
  icon: QuickEntryIcon;
};

/** 首页商品分组（如「亏本单」）。 */
export type ProductSection = {
  id: string;
  title: string;
  moreHref: string;
  products: Product[];
};

/**
 * 首页聚合数据。
 *
 * ⚠️ **形状自 P8B 起未变，P8E-1 也不变**。后台能管素材，但用户端看到的仍然是
 * 「一组公告图 + 一张活动图 + 四个快捷入口」——后台能力适配当前用户产品，
 * 不为了后台 CRUD 改用户端产品形态（§十）。
 */
export type HomeData = {
  announcements: AnnouncementImage[];
  activityImageUrl: string;
  shortcuts: HomeShortcut[];
  sections: ProductSection[];
};

// ——————————————————————— 内部实体（仓储里存的） ———————————————————————

/**
 * 三类运营内容共有的可管理字段。
 *
 * ⚠️ 单独抽出来是为了让「后台能改的字段」这件事**只有一处定义**：
 * `enabled` / `sortOrder` / 软删除 / 时间戳四件事在公告、Banner、快捷入口上一模一样，
 * 各写一遍迟早出现「公告能停用、Banner 不能」这种没有理由的差异。
 *
 * `createdAt` / `updatedAt` **不由客户端提供**，由事务在原子区段内取服务端时间写入。
 */
type ManagedContentFields = {
  /** 是否对用户端可见。停用是**可逆**的，与软删除不是一回事 */
  enabled: boolean;
  /** 用户端展示顺序，升序；相同则按 id 升序（稳定排序，见 `compareContentOrder`） */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /**
   * 软移除时间；`null` 表示未移除。
   *
   * ⚠️ **移除不删记录**：与类目、商品同一个理由——已经发出去的图、用户看过的内容，
   * 事后要能回答「当时首页上那张图是什么」。真删了就只能靠猜。
   */
  removedAt: string | null;
};

/** 图片公告的完整记录（后台口径）。 */
export type ContentAnnouncementRecord = ManagedContentFields & {
  id: string;
  /** 仅供后台辨认素材用；**不进用户端 DTO**（公告区不显示文字） */
  title: string;
  imageUrl: string;
  /** 图片替代文本，进用户端 DTO：它服务于读屏，不是给人看的标题 */
  alt: string;
};

/** 活动 Banner 的完整记录（后台口径）。 */
export type ContentBannerRecord = ManagedContentFields & {
  id: string;
  /** 后台辨认用；用户端只取 `imageUrl` */
  title: string;
  imageUrl: string;
  alt: string;
};

/** 首页快捷入口的完整记录（后台口径）。 */
export type QuickEntryRecord = ManagedContentFields & {
  id: string;
  label: string;
  icon: QuickEntryIcon;
  /**
   * 站内绝对路径，如 `/join`。
   *
   * ⚠️ 写入前必须过 `validateSafePath()`（`lib/constants/safePath.ts`）。
   * 仓储**不替调用方校验**（它只保证自己这份数据自洽），但事务层在写之前一定校验，
   * 因此这个字段里不可能出现 `javascript:` 或站外地址。
   */
  path: string;
};

// ——————————————————————— 管理端 DTO ———————————————————————

/**
 * 管理端列表项共有的字段。
 *
 * ⚠️ 与实体只差一处，而且是刻意的：`removedAt: string | null` 被换成 `removed: boolean`。
 * 后台列表要显示的是「这条还在不在」，不是一个时间戳；反过来，把移除时间暴露出去
 * 对列表页没有任何用处，却在 DTO 里多留了一个将来会被前端误用的字段。
 * 需要看移除时间的地方（详情 / 审计）走的是**实体与审计快照**，不是这个 DTO。
 */
type AdminContentFields = {
  id: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** 是否已软移除。列表默认看不到已移除的记录，需要显式筛 */
  removed: boolean;
};

/** 管理端公告列表项 / 表单回填。 */
export type AdminAnnouncementItem = AdminContentFields & {
  title: string;
  imageUrl: string;
  alt: string;
};

/** 管理端活动 Banner 列表项 / 表单回填。 */
export type AdminBannerItem = AdminContentFields & {
  title: string;
  imageUrl: string;
  alt: string;
};

/** 管理端快捷入口列表项 / 表单回填。 */
export type AdminQuickEntryItem = AdminContentFields & {
  label: string;
  icon: QuickEntryIcon;
  path: string;
};

/**
 * 管理端列表返回。
 *
 * ⚠️ 三张列表都**不分页**：这类运营内容在任何现实运营里都是个位数到几十条，
 * 加分页会带来「改完第 3 页的排序，第 1 页没变」这类纯粹由分页制造的问题，
 * 而它解决的是一个不存在的问题。数量真涨上来时再加，届时是一个明确的决定。
 */
export type AdminContentList<T> = {
  /** 当前筛选条件下的记录，已按 `sortOrder` → `id` 排序 */
  items: T[];
  /**
   * **未移除**的记录总数。
   *
   * ⚠️ 与 `items.length` 不是一回事：筛选 `removal=removed` 时 `items` 装的是
   * 已移除的那批，而 `total` 仍然是「还在用的有多少条」。
   * 后台页面上「共 N 条」说的是后者——运营关心的是自己手上还有多少素材。
   */
  total: number;
  /** 四个角标的数字，加起来等于全部记录数（含已移除）。与类目页同一套口径。 */
  counts: { all: number; enabled: number; disabled: number; removed: number };
};

/**
 * 后台可编辑的字段（**已经校验、已去空白**的形态）。
 *
 * ⚠️ 与实体只差四个服务端字段：`id` / `createdAt` / `updatedAt` / `removedAt`。
 * 它们**在服务端没有读取的位置**——客户端在请求体里多传一个也不会有任何效果
 * （§九：客户端伪造 ID、状态、时间必须被忽略）。`removedAt` 尤其重要：
 * 移除是一条**独立的状态迁移**（有自己的接口与审计动作），不是一个可编辑字段。
 */
export type AdminAnnouncementProfilePatch = {
  title: string;
  imageUrl: string;
  alt: string;
  sortOrder: number;
  enabled: boolean;
};

/** 活动 Banner 的可编辑字段与公告完全相同（两者都是「一张图 + 一个后台标题」）。 */
export type AdminBannerProfilePatch = AdminAnnouncementProfilePatch;

/** 快捷入口的可编辑字段：比图片类多一个 `icon`、少一个 `alt`，并且路径要过安全校验。 */
export type AdminQuickEntryProfilePatch = {
  label: string;
  icon: QuickEntryIcon;
  path: string;
  sortOrder: number;
  enabled: boolean;
};

// ——————————————————————————— 种子形状 ———————————————————————————

/**
 * 首页商品分组的**种子形状**：存的是商品 id，不是商品。
 *
 * ⚠️ 存 id 而不是 `Product` 对象，是「首页与后台读同一份数据」这条要求的落点。
 * 存对象的话，首页拿到的就是种子被复制那一刻的价格与封面，
 * 后台改价之后首页还显示旧价——而且是那种「只有对比两个页面才发现」的不一致。
 *
 * ⚠️ 公告 / 活动图 / 快捷入口的种子**不在这里**，从 P8E-1 起它们在
 * `lib/mocks/fixtures/contentSeed.ts`，而且是**仓储的初始记录**（含 `enabled` /
 * `sortOrder` / 软删除），不是用户端数据本身——后台改完之后用户端刷新就是新的，
 * 因为两边读的本来就是同一条记录。
 */
export type HomeSectionSeed = {
  id: string;
  title: string;
  moreHref: string;
  productIds: string[];
};
