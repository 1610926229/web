/**
 * 「我的」页功能入口配置。
 *
 * 入口清单**照原型的宫格顺序与名称**抄下来，不自行增删或改叫法：
 * 上方四个大入口（主功能）+ 分隔线下方的小宫格。层级差异只体现在样式上（见 `tile`）。
 *
 * ⚠️ 本文件没有运行时依赖（`import type` 同样会被编译掉），客户端组件可以安全引用，
 * node 也能直接加载它做纯逻辑测试。
 *
 * 关于 `kind`：
 * - `link`：目标页面已经存在（真页面或统一占位页），点击即跳转，**不会 404**；
 * - `notice`：目标地址尚未确定（如「同款系统」的外部链接），**不允许编造 URL**，
 *   点击后固定提示「链接暂未配置」，而不是做成点了没反应。
 */

export type MineEntryKind = "link" | "notice";

export type MineEntry = {
  id: string;
  label: string;
  kind: MineEntryKind;
  /** `kind: "link"` 时的目标地址；`notice` 时为空串 */
  href: string;
  /** `kind: "notice"` 时的提示文案；`link` 时为空串 */
  notice: string;
  /** 图标键，对应 `components/mine/MineIcons.tsx` 里的图形 */
  icon: string;
  /** 磁贴配色类名（仅主功能入口使用）；小宫格为空串 */
  tile: string;
};

/** 主功能入口：原型中四个带底托的大图标。 */
export const MINE_PRIMARY_ENTRIES: readonly MineEntry[] = [
  { id: "orders", label: "我的订单", kind: "link", href: "/orders", notice: "", icon: "orders", tile: "mine-tile-pink" },
  { id: "complaints", label: "投诉进度", kind: "link", href: "/complaints", notice: "", icon: "complaints", tile: "mine-tile-magenta" },
  { id: "join", label: "成为护航", kind: "link", href: "/join", notice: "", icon: "join", tile: "mine-tile-blue" },
  { id: "favorites", label: "商品收藏", kind: "link", href: "/favorites", notice: "", icon: "favorites", tile: "mine-tile-amber" },
];

/**
 * 同款系统：原型是一个外部链接入口，但**目标地址尚未确定**。
 * 不允许编造一个看起来能用的网址，点击后只如实说明未配置。
 */
export const EXTERNAL_LINK_NOT_CONFIGURED_MESSAGE = "链接暂未配置";

/** 小宫格入口：顺序与原型一致（4 / 4 / 3）。 */
export const MINE_GRID_ENTRIES: readonly MineEntry[] = [
  { id: "rank", label: "消费排行榜", kind: "link", href: "/rank", notice: "", icon: "rank", tile: "" },
  { id: "coupon", label: "我的优惠券", kind: "link", href: "/coupons", notice: "", icon: "coupon", tile: "" },
  { id: "review", label: "我的评价", kind: "link", href: "/reviews", notice: "", icon: "review", tile: "" },
  { id: "agreement", label: "相关协议", kind: "link", href: "/agreements", notice: "", icon: "agreement", tile: "" },
  // 陪玩列表的正式路由是**复数** /companions（不是单数 /companion）
  { id: "companion", label: "寻找陪玩", kind: "link", href: "/companions", notice: "", icon: "companion", tile: "" },
  { id: "tips", label: "鸡腿记录", kind: "link", href: "/tips", notice: "", icon: "tips", tile: "" },
  { id: "suggestion", label: "功能建议", kind: "link", href: "/suggestions", notice: "", icon: "suggestion", tile: "" },
  { id: "activity", label: "福利活动", kind: "link", href: "/activities", notice: "", icon: "gift", tile: "" },
  { id: "level", label: "消费等级", kind: "link", href: "/rights", notice: "", icon: "level", tile: "" },
  { id: "help", label: "帮助中心", kind: "link", href: "/help", notice: "", icon: "help", tile: "" },
  {
    id: "same-system",
    label: "同款系统",
    kind: "notice",
    href: "",
    notice: EXTERNAL_LINK_NOT_CONFIGURED_MESSAGE,
    icon: "external",
    tile: "",
  },
];

/** 全部功能区的标题（原型文案）。 */
export const MINE_SECTION_TITLE = "全部功能";

/** 资料区两个圆形按钮的无障碍名称。 */
export const MINE_EDIT_LABEL = "编辑资料";
export const MINE_SETTINGS_LABEL = "设置";
