import type { AdminApplicationStatusFilter } from "@/lib/constants/adminApplications";
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
 * 售后工作台（P1-3）。
 *
 * ⚠️ 它是一个**聚合入口**，不是把退款与投诉合成一个模块——
 * 两个专用入口与它们各自的处置动作都原样保留，详见 `ADMIN_NAV_ITEMS` 上的注释。
 */
export const ADMIN_AFTERSALES_PAGE_TITLE = "售后工作台";
/**
 * 优惠券发放（P1-4 验收整改轮 §四）。
 *
 * ⚠️ 这一页管的是**发放**，不是**配置**：挑一张已启用的券模板发给指定用户。
 * 「券模板怎么建、怎么改」不在这条入口里——`ADMIN_UPCOMING_MODULES` 里的
 * 「消费等级与优惠券配置」说的才是那件事（本阶段未实现），两者不要混为一谈。
 */
export const ADMIN_COUPONS_PAGE_TITLE = "优惠券发放";
/**
 * 优惠券发放页的口径说明。
 *
 * 两件事必须说出来，否则管理员会按别处的直觉猜错：
 *
 * 1. **发出去的券就在用户自己的列表里**。它与用户自己领的落在同一份记录上，
 *    对方在「我的优惠券」中立刻能看到，不需要任何同步动作。
 * 2. **可以重复发**。发放不受「同一用户对同一模板只能领一次」的限制：
 *    同一个人可以收到同一模板的多张券，每张各自核销一次。
 *    因此页面上刻意**不做**「他已经领过了」这类拦截，而是在挑人时把
 *    已持有的张数显示出来，让人自己判断。
 */
export const ADMIN_COUPONS_NOTICE =
  "向指定用户发放优惠券。发出去的券与用户自己领取的落在同一份记录里，" +
  "对方可在自己的「我的优惠券」中立即看到，不需要任何同步动作。" +
  "发放不受「同一用户对同一模板只能领一次」的限制：可以对同一个人重复发放同一模板的多张券，" +
  "每张各自核销一次。";
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
 * 概览页（经营首页）的数据口径说明。
 *
 * ⚠️ 本页的形状在 **P1-1** 变过：从「入口页」升级为**经营首页**——顶部是
 * 「今日经营」与「当前待办」（当天的、需要管理员动作的），底部才是原来那七个
 * **全量累计**数字。这句话必须跟着事实改：它此前写着「本页只汇总入驻申请与护航规模」，
 * 而 `docs/03-dev/需求功能点进度表.md` 正是拿这句话当作「首页没有经营数据」的证据。
 *
 * ⚠️ 升级后仍要**明确写出底部那一排是全量累计**：否则「待审核申请 12」
 * 会被读成「今天新增 12」，而它其实是所有历史申请里仍未审完的总数。
 *
 * ⚠️ 这段文字由 `<p>{…}</p>` **原样渲染**，React 不解析 Markdown——
 * 写 `**加粗**` 只会让页面上出现四个星号。要用「」强调。
 *
 * ⚠️ 上面两块原本是**两段叠在一起的注释**（P1-1 留下的），JSDoc 只认最后一块，
 * 于是「本页形状变过」那段说明对编辑器与文档工具都不可见。这里是合并，不是新增内容。
 */
export const ADMIN_OVERVIEW_NOTICE =
  "数字全部从本地 Mock 仓储实时聚合，不是写死的展示值。" +
  "顶部「今日经营」与「当前待办」按当天北京时间与待处理状态统计；" +
  "底部那一排是入驻申请与护航规模的「全量累计」，与日期无关。";

/**
 * 底部那排累计卡片的标题。
 *
 * ⚠️ 「（全量累计）」四个字不是装饰：它在同一屏里与上面的「今日订单」并排出现，
 * 不加这个词就分不清哪些数字按天、哪些数字从来如此。
 */
export const ADMIN_OVERVIEW_CUMULATIVE_TITLE = "申请与护航规模（全量累计）";

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
  //
  // ⚠️ P1-3 在此之上加了第三个**聚合入口**（「售后工作台」，`/admin/aftersales`），
  // 它**不推翻**上面这句判断，理由逐条记在这里：
  //
  // - 原判断针对的是「把两种**处置动作**合成一个」：一边动订单与金额
  //   （批准要写订单状态、退款额与打手收益冲回），一边只写平台侧结论、一分钱都不动。
  //   把这两件事做进同一个控制台，操作的人迟早分不清自己按下去的是哪一种。
  // - 工作台改的不是这件事。它是**只读的分流队列**：回答「现在有哪些案件等着人处理」，
  //   按视图（未完结 / 处理中 / 已结束）分桶、按案件编号 / 订单号 / 昵称搜，
  //   一行都不写；**没有任何一个处置动作被搬进来**。
  // - 点进去之后渲染的正是既有的 `AdminRefundConsole` / `AdminComplaintConsole`——
  //   两种处置动作仍然各在各的详情页里，边界一步都没挪。
  // - 上面两条原有入口（`/admin/refunds`、`/admin/complaints`）**原样保留**：
  //   工作台是「从哪开始找」的入口，不是「在哪操作」的替代。
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
  // P1-3：售后工作台（退款与投诉的**混合待办队列**，只读）。
  // ⚠️ 它为什么不与上面那句「两个模块不是一个售后模块」冲突，见本数组开头的说明。
  {
    key: "aftersales",
    href: "/admin/aftersales",
    label: ADMIN_AFTERSALES_PAGE_TITLE,
    description: "退款与投诉的混合待办队列",
  },
  // P8D-1：客服账号。**独立于用户与管理员**的第三类身份，
  // 只管「谁可以登录 /staff 的客服工作台」，与用户端名单、排行榜没有交集。
  {
    key: "customer-service",
    href: "/admin/customer-service",
    label: ADMIN_CUSTOMER_SERVICE_PAGE_TITLE,
    description: "客服账号的新增、启停与软删除",
  },
  // P1-4 验收整改轮 §四：优惠券发放。它是**运营动作**，不是售后动作——
  // 不碰任何订单、不产生退款，只是以另一种来源**产生**一张新券
  // （与用户自己领的落在同一份数据里）。因此它排在订单 / 退款 / 投诉 / 售后工作台
  // 这一组之后，而不是挨着它们中间。
  //
  // ⚠️ 它排在 `platform-config` **之前**，而不是最末：下面那条「平台参数放在最后」的
  // 理由（它是**全局规则本身**，上面每一条都是「业务对象与账号」）在这里仍然要成立。
  // 发券是对一个业务对象做一次动作，属于「业务对象与账号」这一侧；
  // 把它插到平台参数后面，反而会让「规则类排在最后」这条读法失效。
  //
  // ⚠️ `tests/admin.test.mjs` 里有一条按顺序逐项比对的导航断言，
  // 它会随本项一起变红，需要同步补上 `/admin/coupons`。
  {
    key: "coupons",
    href: "/admin/coupons",
    label: ADMIN_COUPONS_PAGE_TITLE,
    description: "向指定用户发放优惠券",
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

/**
 * 概览卡片点进去之后的列表筛选地址。参数名与服务端读的一致。
 *
 * ⚠️ 参数类型是**该模块的筛选联合**（含查询层虚拟值 `open`），不是领域状态：
 * 经营首页的「打手申请」卡就落在 `?status=open` 上（P1-1 的 R6 裁定——
 * 卡上的数必须与点进去的列表条数一致）。用 `type` 导入，因此本文件与
 * `adminApplications.ts` 之间不存在运行时依赖。
 *
 * ⚠️ 该卡片的显示文案是「**打手申请**」（P1-1 人工验收把原来的「待处理申请」改了：
 * 后者不说明是什么申请）。**改的只是文案**——这里的状态集合、计数口径与地址都没动。
 */
export const ADMIN_APPLICATION_LIST_HREF = (status: AdminApplicationStatusFilter): string =>
  `/admin/applications?status=${status}`;

export const ADMIN_COMPANION_LIST_HREF = (filter: "enabled" | "disabled" | "unavailable"): string =>
  `/admin/companions?state=${filter}`;
