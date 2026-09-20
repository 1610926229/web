import type { DispatchAcceptOutcome, DispatchState } from "@/lib/types/dispatch";

/**
 * 派单域的常量与文案（P0-5）。
 *
 * 写法对齐 `lib/constants/platformConfig.ts` 与 `lib/constants/companionConsole.ts`：
 * **时长、状态名、提示语集中在这里**，事务层、服务层、接口与页面引用的是同一份字符串。
 * 「接口说已超时、页面说已被接走」这种自相矛盾，根源永远是同一件事在两处各写了一遍。
 *
 * ⚠️ 本文件**没有任何依赖**（只 import 类型）：浏览器端组件可以安全引用它，
 * 不会因此把 `lib/data` 与 Mock 存储打进产物。
 */

// ——————————————————————————— 时长 ———————————————————————————

/**
 * 专属池的等待时长：**固定 10 分钟，不可配置**。
 *
 * ⚠️ 它不是平台参数，因此**故意**不放进 `PlatformConfig`：那个表里放的是
 * 「产品要能随时调、调完立刻对之后发生的业务生效」的量（如公共池超时）。
 * 专属池的 10 分钟是产品对用户的**承诺**（「指定他，他有十分钟专属时间」），
 * 把它做成可配置项，等于允许平台事后改掉一条已经写在页面上的承诺。
 *
 * 单位：分钟。
 */
export const EXCLUSIVE_WAIT_MINUTES = 10;

/** 毫秒换算：截止时间一律用 `Date.parse(enteredAt) + 分钟数 × 这个值`。 */
const MINUTE_MS = 60_000;

/** 一个时刻加上若干分钟。派单域里所有截止时间都由它算，不各写一遍加法。 */
export function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString();
}

// ——————————————————————————— 状态与池 ———————————————————————————

/** 派单状态在后台与日志里使用的名称。 */
export const DISPATCH_STATE_LABELS: Record<DispatchState, string> = {
  exclusive: "专属池等待",
  public: "公共池等待",
  accepted: "已被接单",
  timed_out: "已超时关闭",
};

/** 打手端看到的池子名。两页共用，避免一页写「专属单」另一页写「指定单」。 */
export const DISPATCH_POOL_LABELS = {
  exclusive: "专属订单池",
  public: "公共订单池",
} as const;

// ——————————————————————————— 打手端页面 ———————————————————————————

export const COMPANION_POOL_PAGE_TITLE = "订单池";
export const COMPANION_EXCLUSIVE_PAGE_TITLE = "专属池";

/**
 * 池子页面最上面那句说明。
 *
 * ⚠️ **必须写「不接会怎样」**：本批次取消了「拒绝」按钮，打手看不到任何「我不接」
 * 的入口，会以为必须做点什么。不说清楚，第一位用的人就会去找客服问
 * 「我不想接这单怎么办」。
 */
export const COMPANION_POOL_NOTICE =
  "这里是你当前可以接的订单。不想接的单不需要任何操作：专属池的单在你手里留 10 分钟，到点自动进入公共池，任何人都可以接。";

/**
 * `available = false`（后台「暂停接单」）时，池子页面顶部换成这一句。
 *
 * ⚠️ 必须同时说清三件事：**你还进得来、资格还在**、**现在接不了新单**、**该找谁**。
 * 只说「暂无订单」的话，一位被暂停接单的护航会以为平台最近没单子，
 * 转头去问客服「为什么我这边没有订单」——而真正的原因在他自己的状态上。
 *
 * ⚠️ 与 `CompanionAccessNotice` 的「资格已下架」**不是同一句话**，也不该合并：
 * 那是 `enabled = false`，那个人连工作台都进不来。这两件事对使用者的下一步动作
 * 完全不同（一个去找管理员开接单，一个去找管理员恢复资格）。
 */
export const COMPANION_POOL_PAUSED_NOTICE =
  "你当前处于「暂停接单」状态：仍然可以进入工作台、查看自己的资料与用户指定给你的订单，但暂时不能接新的订单。要恢复接单请联系管理员。";

/** 暂停接单时，卡片上替代接单按钮的那句话。页面可以隐藏按钮，但**保护不在这里**。 */
export const COMPANION_ACCEPT_PAUSED_NOTICE = "你当前暂停接单，无法接下这一单。";

/** 空池的说明。两种池子各说一句话——「等谁」和「等什么」不是同一件事。 */
export const COMPANION_EXCLUSIVE_EMPTY = "目前没有用户指定给你的订单。";
export const COMPANION_PUBLIC_EMPTY = "公共池暂时是空的，有新订单时会出现在这里。";

/**
 * 暂停接单时公共池的空态。
 *
 * ⚠️ 不能沿用上面那句：那句承诺「有新订单时会出现在这里」，而暂停期间
 * **新订单本来就不会出现**。两句一起显示就是页面自相矛盾——
 * 而自相矛盾的文案，读的人只会以为其中一句是旧的。
 */
export const COMPANION_PUBLIC_EMPTY_PAUSED = "暂停接单期间，公共订单池不显示可接订单。";

export const COMPANION_ACCEPT_LABEL = "接单";
export const COMPANION_ACCEPTING_LABEL = "接单中…";

/**
 * 接单按钮下面的一句提醒。
 *
 * 不写「点击即表示同意」，是因为接单之后**没有放弃入口**——那件事必须让人在点之前知道，
 * 而不是点完之后才从客服那里听说。
 */
export const COMPANION_ACCEPT_NOTICE =
  "接单后由你负责这一单，不能自行退回。无法履约请联系用户或客服。";

/**
 * 接单没成功时页面上要说的话 —— **按结果逐个分开**。
 *
 * ⚠️ 这几句话必须同时回答两件事：**发生了什么**、**我该做什么**。
 * 合成一句「接单失败」，打手就不知道这张卡要不要继续等——
 * 而「被别人接走了」（不用等了）与「网络没通」（重试就行）对他完全不是一回事。
 *
 * 因此它们挂在接口返回的 `kind` 上（见 `DispatchAcceptOutcome`），
 * 不是靠解析错误文案：文案改一个字就断掉的映射，迟早会静默错位。
 */
export const DISPATCH_ACCEPT_FAILURE_LABELS: Record<
  Exclude<DispatchAcceptOutcome["kind"], "ok">,
  string
> = {
  "not-found": "这一单已经不在池子里了，请刷新页面。",
  "not-open": "这一单刚被其他护航接走了，请刷新页面。",
  expired: "这一单在你查看的时候已经超时，请刷新页面。",
  "not-eligible": "这一单是用户指定给其他护航的，你不在范围内。",
  // 两种原因（资料已下架 / 已移除、当前暂停接单）共用一句：对外是同一个业务结果，
  // 对打手要做的事也是同一件——去找管理员。分开说只会多出一句他无从判断的话
  "companion-unavailable": "你当前不能接单（资料不可用或已暂停接单），请联系管理员。",
  "order-closed": "这一单已经关闭，不能再接了。",
  // 名字取自需求里的异常编号 EX-DISPATCH-08「禁止自接单」：沿用它的用词，
  // 代码里的 kind 与需求文档里的那条规则一眼对得上。这条**不是**「你资格不够」，
  // 所以他真正该做的事是「什么都不用做」——说清楚，否则他会以为重试就能接。
  "self-order": "这一单是你自己下的，不能接自己的单。它会继续等其他护航，你不用再操作。",
};

/** 接单成功后的提示。`replayed` 的两种情形共用一句：结果对使用者是同一件事。 */
export const DISPATCH_ACCEPT_SUCCESS_LABEL = "接单成功，订单已归你负责。";

// ——————————————————————————— 通知文案 ———————————————————————————

/**
 * 三件事各一条通知，**收件人都是下单的用户**。
 *
 * ⚠️ 标题与正文里**不得出现游戏账号、备注等订单隐私**（见 `lib/types/notification.ts`）：
 * 通知是只读展示，要看细节请顺着 `href` 进订单详情页，那里会重新校验归属。
 *
 * ⚠️ 这三条文案的**收件人只可能是订单所属用户**，因此它们不接受「发给谁」这种参数——
 * 归属由订单决定，不由调用方声明。
 */
export const DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT = {
  title: "指定护航未接单",
  summary: "你指定的护航没有接下这一单，订单已进入公共订单池",
  body: "你指定的护航在专属时间内没有接单，订单已经自动进入公共订单池，其他护航可以接取。订单金额与状态均不受影响。",
} as const;

export const DISPATCH_NOTIFICATION_PUBLIC_TIMEOUT = {
  title: "订单已自动退款",
  summary: "公共订单池长时间无人接单，订单已全额退款",
  body: "订单在公共订单池中等待超过平台设定的时间仍无人接单，已自动全额退款，退款将原路返回。",
} as const;

export const DISPATCH_NOTIFICATION_ACCEPTED = {
  title: "订单已被接单",
  summary: "你的订单已有护航接单",
  body: "你的订单已有护航接下，接下来他会与你联系并开始服务。",
} as const;
