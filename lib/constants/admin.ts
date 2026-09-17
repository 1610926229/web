import { PLATFORM_NAME } from "@/lib/constants/site";
import type { AdminRole } from "@/lib/types/admin";
import type { Companion } from "@/lib/types/companion";
import type { CompanionApplicationStatus } from "@/lib/types/companionApplication";

/**
 * 管理后台的角色规则、导航与概览口径（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型外没有运行时依赖，node 能直接加载它做纯逻辑测试，
 * 客户端组件引用它也不会把服务端模块打进浏览器产物。
 *
 * 三条边界写在这里：
 *
 * 1. **只有 `admin` 能进管理后台**。规则只在 `canEnterAdminConsole()` 里判断一次，
 *    页面、布局、接口守卫全部调它，不各自写 `role === "admin"`。
 * 2. **角色判断只认服务端会话读出来的账号**。没有任何函数接收「客户端传来的角色」——
 *    客户端说自己是 admin 不构成任何权限。
 * 3. **不承诺后续阶段的能力**。未开放模块一律标注「后续开放」并且**没有链接**，
 *    不做成能点进去的空壳。
 */

// ——————————————————————————— 角色 ———————————————————————————

export const ADMIN_ROLES: readonly AdminRole[] = ["admin", "customer_service", "companion"];

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  admin: "管理员",
  customer_service: "客服",
  companion: "护航",
};

/**
 * 能否进入管理后台并调用管理接口。**全站唯一的角色判断。**
 *
 * 注意判断的是「角色等于 admin」，而不是「角色不等于某某」：
 * 将来新增角色时，新角色默认没有权限，而不是默认获得权限。
 * 停用（`enabled === false`）在会话层就被挡掉，到这里已经只剩「存在且启用」的账号。
 */
export function canEnterAdminConsole(role: AdminRole): boolean {
  return role === "admin";
}

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

export function adminRoleLabel(role: AdminRole): string {
  return ADMIN_ROLE_LABELS[role];
}

// ——————————————————————————— 文案 ———————————————————————————

/** 侧栏标题。平台名取自 `PLATFORM_NAME`（全站唯一一处），后台不另起一个平台名。 */
export const ADMIN_CONSOLE_NAME = `${PLATFORM_NAME} · 管理后台`;
export const ADMIN_LOGIN_PAGE_TITLE = "管理后台登录";
export const ADMIN_OVERVIEW_PAGE_TITLE = "后台概览";
export const ADMIN_APPLICATIONS_PAGE_TITLE = "入驻审核";
export const ADMIN_COMPANIONS_PAGE_TITLE = "护航管理";
export const ADMIN_CATEGORIES_PAGE_TITLE = "类目管理";
export const ADMIN_PRODUCTS_PAGE_TITLE = "商品管理";
/**
 * 运营内容（首页素材）。
 *
 * ⚠️ 这是一个**模块**而不是四个：图片公告 / 活动 Banner / 快捷入口 / 协议
 * 都是「首页与协议页上用户看到的那点内容」，四个扁平入口会让侧栏长出一截
 * 彼此看不出关系的菜单项。四个子模块做成 `/admin/content/*` 下的子页签
 * （见 `components/admin/AdminContentTabs.tsx`）。
 */
export const ADMIN_CONTENT_PAGE_TITLE = "运营内容";
export const ADMIN_ORDERS_PAGE_TITLE = "订单管理";
export const ADMIN_REFUNDS_PAGE_TITLE = "退款审核";
export const ADMIN_COMPLAINTS_PAGE_TITLE = "投诉处理";
/**
 * 侧栏与页头的模块名。
 *
 * ⚠️ 页面地址是 `/admin/customer-service`，而模块名与侧栏标签是「客服账号」——
 * 两者刻意不同：地址说的是「客服」，标签说的是「这一页管的是账号」。
 * 客服本人在 `/staff` 工作，运营在这里管的是**谁能进那个工作台**。
 */
export const ADMIN_CUSTOMER_SERVICE_PAGE_TITLE = "客服账号";
/**
 * 平台参数（公共订单池超时等）。
 *
 * ⚠️ 这里是**规则**不是**数据**：这一页改的是「此后新发生的业务按什么走」。
 * 已经进入公共池的订单不受影响——它们在进入那一刻就把当时的参数值冻结成了快照。
 * 页面文案（`PLATFORM_CONFIG_NOTICE`）必须把这一点说出来，否则管理员改完
 * 看到在途订单没变化，会以为没保存成功然后再改一次。
 */
export const ADMIN_PLATFORM_CONFIG_PAGE_TITLE = "平台参数";
export const ADMIN_LOGOUT_LABEL = "退出登录";
export const ADMIN_MOCK_LOGIN_LABEL = "模拟管理员登录";

/**
 * 登录页与管理后台顶部的 Mock 标注。
 *
 * 必须一眼看出这是本地模拟：本阶段没有真实管理员账号与密码，
 * 也没有接任何真实的权限系统。
 */
export const ADMIN_MOCK_NOTICE =
  "管理后台为本地 Mock 环境：没有真实管理员账号与密码，登录入口是固定的模拟登录，" +
  "数据来自本地 Mock Store，重启开发服务器后回到预置数据。";

/** 未启用 `ENABLE_MOCK_ADMIN` 时登录页显示的说明（此时不渲染任何登录控件）。 */
export const ADMIN_MOCK_DISABLED_MESSAGE =
  "模拟管理员登录未启用（ENABLE_MOCK_ADMIN 未开启）。管理后台需要正式的管理员账号体系，本阶段尚未实现。";

/** 登录接口未启用时返回的提示，与页面文案同源。 */
export const ADMIN_MOCK_LOGIN_DISABLED_MESSAGE = "模拟管理员登录未启用";

/** 角色不是 admin 时的提示。与接口 403 的 message 同源。 */
export const ADMIN_FORBIDDEN_MESSAGE = "当前账号没有管理后台权限";

/** 未登录（或会话失效）时的提示。与接口 401 的 message 同源。 */
export const ADMIN_UNAUTHORIZED_MESSAGE = "请先登录管理后台";

/**
 * 概览页的数据口径说明。
 *
 * ⚠️ 订单、退款与投诉已经各有页面（订单管理 / 退款审核 / 投诉处理），
 * 但**本页仍然只汇总入驻申请与护航规模**：那三块的数字按「状态 × 时间」切片才有意义，
 * 塞进这两排卡片里会变成一堆看不出趋势的数字。这句话必须跟着事实改——
 * 说「属于后续阶段」会让人以为侧栏里那三个入口是摆设。
 */
export const ADMIN_OVERVIEW_NOTICE =
  "数字从本地 Mock 仓储实时聚合，不是写死的展示值；本页只汇总入驻申请与护航规模，" +
  "订单、退款与投诉在各自的页面里查看。";

// ——————————————————————————— 导航 ———————————————————————————

export type AdminNavItem = {
  key: string;
  href: string;
  label: string;
  /** 侧栏一行小字，说明这个模块是干什么的 */
  description: string;
};

/** 已开放的管理模块。侧栏按这个顺序渲染。 */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  {
    key: "overview",
    href: "/admin",
    label: ADMIN_OVERVIEW_PAGE_TITLE,
    description: "待审核与护航规模的实时汇总",
  },
  {
    key: "applications",
    href: "/admin/applications",
    label: ADMIN_APPLICATIONS_PAGE_TITLE,
    description: "查看、审核与转为护航人员",
  },
  {
    key: "companions",
    href: "/admin/companions",
    label: ADMIN_COMPANIONS_PAGE_TITLE,
    description: "护航资料、启用状态与移除",
  },
  {
    key: "categories",
    href: "/admin/categories",
    label: ADMIN_CATEGORIES_PAGE_TITLE,
    description: "类目归属、排序、启用与移除",
  },
  {
    key: "products",
    href: "/admin/products",
    label: ADMIN_PRODUCTS_PAGE_TITLE,
    description: "商品图文、上下架与单组规格",
  },
  // P8E-1：首页运营内容。放在商品管理之后，因为两者是同一类东西——
  // 都是「用户端看得到的素材」，改完刷新前台就会变；而它下面的订单 / 退款 / 投诉
  // 是交易与售后，与素材不是一回事。
  {
    key: "content",
    href: "/admin/content",
    label: ADMIN_CONTENT_PAGE_TITLE,
    description: "首页公告、活动图、快捷入口与协议正文",
  },
  // P8C：订单只读查询、退款审核与投诉处理。**退款与投诉是两个模块**，
  // 不是一个「售后」模块——一边动订单与金额，一边只写平台侧结论，合成的入口会让人分不清。
  {
    key: "orders",
    href: "/admin/orders",
    label: ADMIN_ORDERS_PAGE_TITLE,
    description: "全量订单只读查询与售后摘要",
  },
  {
    key: "refunds",
    href: "/admin/refunds",
    label: ADMIN_REFUNDS_PAGE_TITLE,
    description: "退款申请审核，通过会同步退款订单（Mock）",
  },
  {
    key: "complaints",
    href: "/admin/complaints",
    label: ADMIN_COMPLAINTS_PAGE_TITLE,
    description: "核实并记录平台侧处理结果",
  },
  // P8D-1：客服账号。**独立于用户与管理员**的第三类身份，
  // 只管「谁可以登录 /staff 的客服工作台」，与用户端名单、排行榜没有交集。
  {
    key: "customer-service",
    href: "/admin/customer-service",
    label: ADMIN_CUSTOMER_SERVICE_PAGE_TITLE,
    description: "客服账号的新增、启停与软删除",
  },
  // P0-1：平台参数。**放在最后**，因为它与上面每一条都不是一类东西——
  // 上面那些是「业务对象与账号」，这一条是**全局规则本身**：
  // 改它不动任何一条已有记录，只改变此后新发生的业务按什么规则走。
  // 放在中间会让人以为它属于相邻那个模块。
  {
    key: "platform-config",
    href: "/admin/platform-config",
    label: ADMIN_PLATFORM_CONFIG_PAGE_TITLE,
    description: "公共订单池超时等平台级规则",
  },
];

/**
 * 后续阶段才开放的模块。
 *
 * ⚠️ **只渲染成禁用项 + 「后续开放」，没有 href**：这些模块本阶段不存在，
 * 给一个能点进去的空壳页面，比什么都不显示更容易让人以为功能已经做好了。
 */
export const ADMIN_UPCOMING_MODULES: readonly string[] = [
  // ⚠️ P8D-1 时这里的第一项是「客服处理退款与投诉」，P8D-2 把它做出来了，因此删掉。
  // 这张表的每一项都是「点了会失望」的东西，做完一项就必须删一项——
  // 留着会让这份清单慢慢变成一份历史记录，而它唯一的作用是回答「现在还没有什么」。
  // P8E-1 因此删掉了「公告与协议管理」：公告、活动图、快捷入口与协议正文
  // 现在都在 `/admin/content` 里，留着它等于在侧栏上写一句已经不成立的话。
  "消费等级与优惠券配置",
  "鸡腿结算",
  "数据统计图表",
];

export const ADMIN_UPCOMING_BADGE = "后续开放";

// ——————————————————————————— 概览口径 ———————————————————————————

/**
 * 概览里「申请」那四个数的来源状态。顺序即页面上的展示顺序。
 *
 * 写成 `as const satisfies` 而不是 `readonly CompanionApplicationStatus[]`：
 * 后者会把元素类型放宽成五个状态，下面两张文案表就不得不为「已撤销」也编一段文案
 * ——而概览刻意不统计它（撤销是用户自己的动作，不是待处理的工作量）。
 */
export const ADMIN_APPLICATION_METRIC_STATUSES = [
  "pending",
  "reviewing",
  "approved",
  "rejected",
] as const satisfies readonly CompanionApplicationStatus[];

/** 概览里「申请」四个数的标题。与申请状态文案同源，不另起一套叫法。 */
export const ADMIN_APPLICATION_METRIC_LABELS: Record<
  (typeof ADMIN_APPLICATION_METRIC_STATUSES)[number],
  string
> = {
  pending: "待审核申请",
  reviewing: "审核中申请",
  approved: "已通过申请",
  rejected: "已拒绝申请",
};

export const ADMIN_APPLICATION_METRIC_HINTS: Record<
  (typeof ADMIN_APPLICATION_METRIC_STATUSES)[number],
  string
> = {
  pending: "已提交、平台尚未开始查看",
  reviewing: "平台已开始查看、尚未给出结果",
  approved: "审核通过，已（或即将）转为护航人员",
  rejected: "审核未通过",
};

/** 概览里「护航」三个数的标题与口径。 */
export const ADMIN_COMPANION_METRIC_LABELS = {
  enabled: "已启用护航",
  disabled: "已停用护航",
  unavailable: "暂不可接单护航",
} as const;

export const ADMIN_COMPANION_METRIC_HINTS = {
  enabled: "在平台上架、可以出现在公开名单里",
  disabled: "已停用，不出现在公开名单里",
  unavailable: "在架但当前接不了单（休息中或已排满）",
} as const;

/**
 * 护航三个数的统计口径。
 *
 * ⚠️ 这里只用 `Companion` 上**已经存在**的两个字段：
 * - `enabled` 决定「启用 / 停用」（是否上架）；
 * - `available` 只对**已启用**的记录有意义——下架的记录本来就不接单，
 *   把它的 `available: false` 也算进「暂不可接单」，会让这个数字虚高，
 *   而且「暂不可接单」这句话对一条下架记录并不成立。
 *
 * 写成纯函数而不是散在页面里，是为了让「这个数是怎么来的」只有一处，
 * 并且能在 node 测试里直接验证。
 */
export function countCompanionStates(companions: readonly Companion[]): {
  enabled: number;
  disabled: number;
  unavailable: number;
  total: number;
} {
  let enabled = 0;
  let disabled = 0;
  let unavailable = 0;

  for (const companion of companions) {
    if (companion.enabled) {
      enabled += 1;
      if (!companion.available) unavailable += 1;
    } else {
      disabled += 1;
    }
  }

  return { enabled, disabled, unavailable, total: companions.length };
}

/** 概览卡片点进去之后的列表筛选地址。参数名与服务端读的一致。 */
export const ADMIN_APPLICATION_LIST_HREF = (status: CompanionApplicationStatus): string =>
  `/admin/applications?status=${status}`;

export const ADMIN_COMPANION_LIST_HREF = (filter: "enabled" | "disabled" | "unavailable"): string =>
  `/admin/companions?state=${filter}`;
