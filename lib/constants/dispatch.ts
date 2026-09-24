import type { CompanionReleaseSource } from "@/lib/types/companionRelease";
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
 * 不写「点击即表示同意」，是因为接单之后**有且只有一条退出路径**——那件事必须让人
 * 在点之前知道，而不是点完之后才从客服那里听说。
 *
 * ⚠️ **这句话在 P0-6 之后被改过**：原文是「接单后由你负责这一单，不能自行退回」，
 * 而「不能自行退回」在 `accepted` 阶段**已不再成立**（打手可以在开始服务前提交原因
 * 取消接单，`Order: accepted → paid`，订单回到公共池）。
 * 留着一句已被改掉的规则，就等于在页面上承诺一件平台不再要求的事——
 * 而那个页面上同时还会出现一个「取消接单」按钮，两句放在一起就是自相矛盾。
 *
 * 仍然要保留「接单后由你负责」这半句：取消有前提（**尚未开始服务**），
 * 不是「随时可以反悔」。
 */
export const COMPANION_ACCEPT_NOTICE =
  "接单后由你负责这一单。开始服务前如无法履约，可提交原因取消接单，订单会回到公共订单池等待其他护航接取。";

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

// ——————————————————————————— 打手端「我的订单」与取消接单（P0-6） ———————————————————————————

/**
 * 打手订单详情取不到时的提示（404）。
 *
 * ⚠️ 「不存在」与「存在但不是你的」**共用这一句**：两者对外表现必须完全一致，
 * 否则可以拿别人的订单 id 试探它是否存在（api-contract §2.9）。
 * 措辞上因此不说「这不是你的订单」——那等于确认了这一单存在。
 */
export const COMPANION_ORDER_NOT_FOUND_MESSAGE = "订单不存在或不可操作";

/** 取消接单没填原因时的提示。**只有「必填」，没有长度要求**（需求未冻结字数）。 */
export const COMPANION_CANCEL_REASON_REQUIRED_MESSAGE = "请填写取消接单的原因";

/**
 * 是本人的单、但状态已不是 `accepted` 时的提示（400）。
 *
 * ⚠️ 它与 `COMPANION_ORDER_NOT_FOUND_MESSAGE` **必须分开**：这一单确实是他的，
 * 只是此刻不该出现「取消接单」这个按钮（已经开始服务 / 已完成 / 已退款）。
 * 说成 404 会让他以为订单丢了。
 */
export const COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE = "当前订单状态不允许取消接单";

// ——— 「我的订单」页面（P0-6）———

/** 「我的订单」页面的标题。工作台导航与页面标题引用的是同一份字符串。 */
export const COMPANION_ORDERS_PAGE_TITLE = "我的订单";

/**
 * 订单详情的页面标题。
 *
 * ⚠️ 它**不在导航里**（详情是二级页面），但仍然要有：工作台每一页都先说明
 * 「这一页是什么」，否则从某一单点进来看到的第一块就是状态与金额，分不清是哪一层。
 */
export const COMPANION_ORDER_DETAIL_PAGE_TITLE = "订单详情";

/**
 * 一单都没接过时的空态。
 *
 * ⚠️ 说的是「**你**还没接过单」，不是「平台没有单」：一位新打手看到后者会去问客服
 * 「为什么我这里没有订单」，而真正的原因是他还没接。池子里有没有单由池子页面回答
 * ——`COMPANION_EXCLUSIVE_EMPTY` / `COMPANION_PUBLIC_EMPTY` 已经承担了那件事。
 */
export const COMPANION_ORDERS_EMPTY_TITLE = "你还没有接过订单";
export const COMPANION_ORDERS_EMPTY_DESCRIPTION = "在订单池接单后，接下的单会出现在这里。";

/** 回到列表的那句入口文案。详情页底部与取消成功的反馈区共用同一句。 */
export const COMPANION_ORDERS_BACK_LABEL = "返回我的订单";

/**
 * 列表页顶部那句说明。
 *
 * ⚠️ 必须点出「取消接单在详情页里」：取消入口只长在 `accepted` 的详情页上，
 * 不在列表上。不写这一句，一位临时有事接不了单的打手会以为平台上根本没有退出的路
 * ——而「接单之后能不能反悔」正是 `COMPANION_ACCEPT_NOTICE` 在接单前承诺过的事，
 * 两句话说的是同一件事，不能只有接单前那一句。
 */
export const COMPANION_ORDERS_NOTICE =
  "这里是你接过的订单。开始服务前如无法履约，打开订单详情即可提交原因取消接单。";

/**
 * 详情取不到时那一页的说明（`notFound()`）。
 *
 * ⚠️ 与 `COMPANION_ORDER_NOT_FOUND_MESSAGE` 同一条约束：**不得区分
 * 「这一单不存在」与「这一单不是你的」**——两者的对外表现必须完全一致，
 * 否则可以拿别人的订单 id 试探它是否存在。因此这里只说「可能不是你当前正在履约的」。
 *
 * 「取消之后它也不再属于你」这半句是**必要的退路**：取消成功之后刷新页面就会到这里，
 * 不写清这一句，那位刚点完取消的打手会以为自己把订单弄丢了。
 */
export const COMPANION_ORDER_NOT_FOUND_DESCRIPTION =
  "这一单可能不是你当前正在履约的订单；取消接单之后它也不再属于你。开发服务器重启会清空内存数据，期间接的单会消失。";

/**
 * 详情页在**不能**取消时替代按钮的那一句（`canCancel === false`）。
 *
 * ⚠️ 按钮消失必须有一句解释：`serving` / `completed` / `refunded` 的详情页上
 * 那个按钮本来就不该出现，不说清「为什么没有」，打手只会以为是页面坏了。
 * 与 `COMPANION_ACCEPT_PAUSED_NOTICE` 同一个取舍——**隐藏按钮是诚实问题，不是保护**。
 */
export const COMPANION_ORDER_CANCEL_UNAVAILABLE_NOTICE =
  "当前状态不能取消接单：只有尚未开始服务的订单可以取消。";

// ——— 取消接单的按钮与反馈（P0-6）———

export const COMPANION_CANCEL_LABEL = "取消接单";
export const COMPANION_CANCEL_CONFIRM_LABEL = "确认取消接单";
export const COMPANION_CANCEL_PENDING_LABEL = "取消中…";

export const COMPANION_CANCEL_REASON_LABEL = "取消原因";
/**
 * 原因输入框的占位文字。
 *
 * ⚠️ **不写任何字数提示**（不写「5~50 字」、不写「至少 x 字」）：需求只要求
 * 「必须填写有效非空文本」，字数规则**没有被冻结**，写了就等于自己造了一条规则，
 * 而服务端并不按它校验——那种提示的唯一作用是让打手白改一遍。
 */
export const COMPANION_CANCEL_REASON_PLACEHOLDER = "请说明无法继续这一单的原因";

/**
 * 展开确认区时的那段说明。
 *
 * ⚠️ 必须同时说清三件事：**这一单不再归你**、**它会回到公共池等其他护航接**、
 * **取消本身没有代价**。最后一条不能省：需求已明确本轮取消不罚款、不影响后续接单，
 * 而一个不写的后果是打手把这次取消当成「违规记录」，宁可放着不管也不点。
 *
 * ⚠️ 也不写「已为你重新派单」：回到公共池之后是「等待**其他**护航接取」，
 * 谁接、什么时候接都还没有发生（与通知文案同一条取舍）。
 */
export const COMPANION_CANCEL_CONFIRM_NOTICE =
  "取消后这一单不再由你负责，会回到公共订单池等待其他护航接取。取消接单不罚款，也不影响你继续接其他订单。";

/**
 * 取消成功后的反馈。
 *
 * ⚠️ 必须点明「它不会再出现在我的订单里」：取消之后这一单确实从列表里消失了
 * （`actualCompanionId` 已清空），不说清的话，打手返回列表找不到它，会以为没生效。
 */
export const COMPANION_CANCEL_SUCCESS_LABEL =
  "已取消接单。这一单已回到公共订单池，不再属于你，也不会再出现在「我的订单」里。";

// ——————————————————————————— 开始服务（P0-7） ———————————————————————————

/**
 * 是本人的单、但状态不是 `accepted` 时的提示（400）。
 *
 * ⚠️ 与 `COMPANION_ORDER_NOT_FOUND_MESSAGE` **必须分开**，与取消同一条理由：
 * 这一单确实是他的，只是此刻不该出现「开始服务」这个按钮（已经开始了 / 已完成 / 已退款）。
 * 说成 404 会让他以为订单丢了。
 */
export const COMPANION_ORDER_NOT_STARTABLE_MESSAGE = "当前订单状态不允许开始服务";

/** 开始服务的按钮与进行中的文案。 */
export const COMPANION_START_LABEL = "开始服务";
export const COMPANION_START_CONFIRM_LABEL = "确认开始服务";
export const COMPANION_START_PENDING_LABEL = "处理中…";

/**
 * 展开确认区时的那段说明。
 *
 * ⚠️ 必须点出**这是一扇单向门**：开始服务之后**没有**普通「取消接单」这条路
 * （需求里 `serving` 不允许打手主动取消）。不说清，一位点错了的打手会去找那个
 * 已经消失的按钮，而不知道真正的出路是联系客服。
 *
 * ⚠️ 也不写「服务时长从此刻开始计算」「请立即联系用户」这类话：需求没有为
 * `servingAt` 冻结任何计价或提醒规则，写了就等于自己造一条规则。
 */
export const COMPANION_START_CONFIRM_NOTICE =
  "开始服务后订单进入「护航中」，下单用户会看到这一单已经开始。开始服务之后不能取消接单，请确认可以继续这一单后再操作。";

/**
 * 成功后的反馈。
 *
 * ⚠️ 两句都不能省：**「这一单现在处于护航中」**（说清这一下发生了什么），
 * **「已不能取消接单」**（说清下一步不能再做什么）。页面此时已经刷新成 `serving`，
 * 取消入口也已经消失，不解释一句，打手只会以为按钮被页面吞了。
 */
export const COMPANION_START_SUCCESS_LABEL =
  "已开始服务。这一单现在处于「护航中」，开始服务后不能取消接单；如遇到无法继续的情况请联系客服。";

/**
 * 履约退出动作的显示名（`CompanionReleaseSource`），管理端订单详情用它。
 *
 * ⚠️ 本轮**只有 `companion_cancel` 有写入路径**。另外两个是 `database-schema.md` T4
 * 已定义的 TARGET 占位（封禁回池 / 客服换人，都属于后续 Round），这里给出名称
 * 只是为了 `Record` 完整——漏掉一个会直接编译不过，而不是为了让它们看起来已有入口。
 * 这也是 `DISPATCH_STATE_LABELS` 的写法：后台/日志用的名称与状态定义放在一起。
 */
export const COMPANION_RELEASE_SOURCE_LABELS: Record<CompanionReleaseSource, string> = {
  companion_cancel: "主动取消接单",
  companion_disabled: "打手资格下架",
  staff_reassign: "客服改派",
};

// ——————————————————————————— 通知文案 ———————————————————————————

/**
 * 四件事各一条通知，**收件人都是下单的用户**。
 *
 * ⚠️ 标题与正文里**不得出现游戏账号、备注等订单隐私**（见 `lib/types/notification.ts`）：
 * 通知是只读展示，要看细节请顺着 `href` 进订单详情页，那里会重新校验归属。
 *
 * ⚠️ 这几条文案的**收件人只可能是订单所属用户**，因此它们不接受「发给谁」这种参数——
 * 归属由订单决定，不由调用方声明。
 *
 * ⚠️ 取消接单那条是**发给下单用户**的，不是发给打手的：打手自己点了取消，
 * 他不需要一条通知来告诉他这件事（页面上会立刻反馈）。真正被影响的是
 * 「以为已经有人在做了」的用户。
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

/**
 * 打手在 `accepted` 阶段主动取消接单（P0-6）。
 *
 * ⚠️ 措辞上**不写「护航跑单」「违规」**：本轮取消不处罚、不罚款、不进人工售后，
 * 是对平台常态的承认。写一句带评价色彩的话，用户会以为平台在处理这件事，
 * 而平台其实什么都没做——真正的处置（若有）属于后续 Round。
 *
 * ⚠️ 也**不说「已为你重新派单」**：回到公共池之后是「等待**其他**护航接取」，
 * 谁接、什么时候接都还没有发生。承诺一件尚未发生的事，比不通知更糟。
 */
export const DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED = {
  title: "护航已取消接单",
  summary: "你的订单已重新进入公共订单池",
  body: "接单的护航在开始服务前取消了这一单，订单已重新进入公共订单池，等待其他护航接取。订单不会被取消，金额也不变。",
} as const;
