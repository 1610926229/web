import {
  COMPANION_EXCLUSIVE_PAGE_TITLE,
  COMPANION_POOL_PAGE_TITLE,
} from "@/lib/constants/dispatch";
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
 */
export const COMPANION_NAV_ITEMS: readonly { href: string; label: string }[] = [
  { href: "/companion", label: COMPANION_OVERVIEW_PAGE_TITLE },
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

// ——————————————————————————— 概览内容 ———————————————————————————

/**
 * 本阶段工作台的边界说明。
 *
 * ⚠️ 这一句**必须跟着实际实现改**：写清楚「哪些还没开放」比让人对着一个空页面猜要好；
 * 而每开放一项就要同步删掉一句，否则它会变成一句阻止打手使用功能的假话。
 */
export const COMPANION_SCOPE_NOTICE =
  "本阶段已开放专属订单池与公共订单池：可以查看并接单。开始服务、完成材料与收益结算尚未开放。";

/**
 * 「后续开放」清单。⚠️ 只是**说明**，页面上没有任何一个对应的按钮或数据。
 *
 * ⚠️ P0-5 已把「订单池」与「接单」两项删掉，并且**不再出现「放弃接单」**：
 * 打手不想接单时什么都不用做，专属池十分钟到点自动转入公共池——
 * 把「放弃接单」留在「后续开放」里，等于承诺一个平台已经决定不做的功能。
 */
export const COMPANION_COMING_SOON_TITLE = "后续开放";
export const COMPANION_COMING_SOON_ITEMS: readonly string[] = [
  "开始服务与提交完成材料",
  "打手收益与分账明细",
];
