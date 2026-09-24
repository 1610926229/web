import {
  COMPANION_EXCLUSIVE_PAGE_TITLE,
  COMPANION_ORDERS_PAGE_TITLE,
  COMPANION_POOL_PAGE_TITLE,
} from "@/lib/constants/dispatch";
import { COMPANION_EARNINGS_PAGE_TITLE } from "@/lib/constants/earnings";
import { PLATFORM_NAME } from "@/lib/constants/site";

/**
 * 打手工作台的文案与页面常量（服务端与浏览器共用）。
 *
 * 写法对齐 `lib/constants/staff.ts`：**文案与判定不写在组件里**，
 * 页面、接口守卫、提示页引用的是同一份字符串——否则「接口说资格已下架、
 * 页面说你不是护航」这种自相矛盾迟早会出现。
 *
 * ⚠️ 本文件**只有字符串与常量**，没有会话、没有仓储、没有权限判断：
 * 访问判定只有一处（`lib/services/companionAccess.ts`）。
 */

// ——————————————————————————— 工作台 ———————————————————————————

/** 工作台标题。平台名取自 `PLATFORM_NAME`（全站唯一一处），打手端不另起一个平台名。 */
export const COMPANION_CONSOLE_NAME = `${PLATFORM_NAME} · 护航工作台`;

export const COMPANION_OVERVIEW_PAGE_TITLE = "工作台";

/**
 * 顶部导航。顺序即页面上从左到右的顺序。
 *
 * 两张池子分成两页而不是一页两个区：它们回答的是**两个不同的问题**——
 * 「用户在等我」（专属池，一对一，十分钟）与「谁都能接」（公共池）。
 * 合成一页的话，打手在专属池里翻找公共单时，会看不出哪些是「本来只给我」的。
 * 标签文案取自 `lib/constants/dispatch.ts`，两个页面与导航引用的是同一份字符串。
 *
 * ⚠️ 「我的订单」与「我的收益」排在**概览之后、两张池子之前**（P0-6 / P0-9），
 * 顺序不是随意的：导航从左到右读下来是
 * 「我是谁 → **我手上的单** → **我这单挣了多少** → 我能接的单」，
 * 即**当前责任**先于**新机会**。把它们放在池子后面，读起来会变成
 * 「先看看有什么可抢的，再看自己扛着什么」——那正是这一轮要纠正的视角。
 * 「工作台」也不能挪到后面：它承担的是「这是谁的地盘」的身份说明作用。
 *
 * ⚠️ 收益紧跟在订单**之后**（而不是更靠后）：问「这一单挣了多少」的人，
 * 十有八九是刚从订单页点过来的；两者被池子隔开的话，他会以为收益在别处。
 * 标签文案取自 `lib/constants/earnings.ts`，页面与导航引用的是同一份字符串。
 */
export const COMPANION_NAV_ITEMS: readonly { href: string; label: string }[] = [
  { href: "/companion", label: COMPANION_OVERVIEW_PAGE_TITLE },
  { href: "/companion/orders", label: COMPANION_ORDERS_PAGE_TITLE },
  { href: "/companion/earnings", label: COMPANION_EARNINGS_PAGE_TITLE },
  { href: "/companion/exclusive", label: COMPANION_EXCLUSIVE_PAGE_TITLE },
  { href: "/companion/pool", label: COMPANION_POOL_PAGE_TITLE },
];

/**
 * 打手身份的称呼。
 *
 * ⚠️ 与护航名单里的「陪玩」是**同一个东西的两种叫法**，而且是刻意保留的：
 * 用户端叫「陪玩」（找个人陪我打），工作台叫「护航」（这是我的行当）。
 * 合并成一个词会让其中一边的文案变得别扭。
 */
export const COMPANION_ROLE_LABEL = "护航";

/**
 * 「打手身份 = 用户身份 + 一条有效的护航资料」这句设计决定，
 * 必须写在页面上而不只写在代码注释里——否则第一位看到工作台的打手会去找
 * 「打手登录入口」，找不到就以为坏了。
 */
export const COMPANION_IDENTITY_NOTICE =
  "打手没有第二个账号：工作台直接用你现在的账号进入，不需要另外登录，也不影响你作为用户的订单与资料。";

// ——————————————————————————— 两种「进不去」———————————————————————————

/**
 * 还不是护航。
 *
 * ⚠️ 与 `COMPANION_NOT_A_COMPANION_MESSAGE` 分开写：接口 403 的 message 是**给调用方**
 * 的一句话，页面上还要有一段说明「怎么办」。两处共用一句话会让页面变成
 * 一个干巴巴的错误提示。
 */
export const COMPANION_NOT_A_COMPANION_TITLE = "你还不是护航";
export const COMPANION_NOT_A_COMPANION_MESSAGE = "你还不是护航，无法进入工作台";
export const COMPANION_NOT_A_COMPANION_DESCRIPTION =
  "护航工作台只对已通过入驻审核的护航开放。提交入驻申请并通过审核后，用现在这个账号就能直接进入。";

/** 资格已下架（有资料，但被管理员下架）。**不是**「没有资格」。 */
export const COMPANION_DISABLED_TITLE = "护航资格已下架";
export const COMPANION_DISABLED_MESSAGE = "你的护航资格已下架，请联系管理员";
export const COMPANION_DISABLED_DESCRIPTION =
  "你的护航资料已被下架，暂时不能进入工作台。这是平台侧的操作，你的账号与其他功能都不受影响；如有疑问请联系客服。";

/** 两种提示页各自的出路：一个去申请入驻，一个去找客服。 */
export const COMPANION_JOIN_LABEL = "去申请成为护航";
export const COMPANION_CONTACT_SERVICE_LABEL = "联系客服";

/** 工作台不在底部 TabBar 里，两种提示页都要给一条明确的退路。 */
export const COMPANION_BACK_TO_MINE_LABEL = "返回我的";

// ——————————————————— 工作台 → 用户端（FIX-1，P0-6.1）———————————————————

/**
 * 从工作台回到**用户端主入口**的入口文案与目标（P0-6.1 FIX-1）。
 *
 * ## 这是界面导航，不是退出登录
 *
 * 打手用的就是用户账号（P0-4）：点它只是**换一个界面看**。
 * 会话 Cookie、Mock 身份、护航资格、用户端资料**一个都不变**——
 * 因此从用户端再走回 `/companion` 时**不需要重新登录**，也不会变成游客。
 * 反过来说：如果这里点完变成了未登录，那就不是本入口，而是一个 bug。
 *
 * ## 为什么是 `/` 而不是 `router.back()`
 *
 * 目标必须**确定**：`components/common/NavBar.tsx` 的返回键走历史回退，
 * 那适合「从列表进详情」；而工作台可以被**直接打开**（收藏、地址栏、微信里的分享），
 * 历史里没有上一页时 `back()` 会把人留在一个空页面上。
 * 这里要回答的是固定问题「用户端在哪」，所以给固定地址。
 *
 * ⚠️ `/` 就是用户端首页——底部 TabBar 的「首页」那一格指向同一个地址
 * （`components/common/TabBar.tsx` 的 `TABS`），**不另立一个「用户端主入口」**。
 *
 * ## 为什么与 `COMPANION_BACK_TO_MINE_LABEL` 分成两条
 *
 * 那一条是**进不去**工作台时（还不是护航 / 资格已下架）的退路，去 `/mine` 看自己的资料；
 * 这一条是**已经在工作台里**时的界面切换，去 `/` 继续逛。两句话的场景不同，
 * 合并成一条会让「返回我的」出现在一个与「我的」无关的位置上。
 */
export const COMPANION_BACK_TO_USER_LABEL = "返回用户端";
export const COMPANION_BACK_TO_USER_HREF = "/";

// ——————————————————————————— 概览内容 ———————————————————————————

/**
 * 本阶段工作台的边界说明。
 *
 * ⚠️ 这一句**必须跟着实际实现改**：写清楚「哪些已经能用、哪些还不能」比让人
 * 对着一个空页面猜要好；每开放一项就要同步改一次，否则它会变成一句阻止打手
 * 使用功能的假话——P0-9 之前它还写着「开始服务、完成材料与收益结算尚未开放」，
 * 而那三件当时都已经开放了。
 *
 * ⚠️ 最后一句说的是**平台决定不做的那一件**（提现），照样要写出来：
 * 与其让打手在收益页上找提现入口，不如在这里直接说清本阶段没有它。
 */
export const COMPANION_SCOPE_NOTICE =
  "本阶段已开放专属订单池、公共订单池、我的订单、开始服务、提交完成材料与我的收益。收益提现不在本阶段范围内。";
