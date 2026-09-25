/**
 * 派单域的类型（P0-5）。
 *
 * ## 为什么要有「派单」这个独立概念
 *
 * 订单支付成功之后、打手接单之前，有一件事必须被记住：**这一单在等谁、等到什么时候**。
 * 它不属于订单（订单回答的是「卖了什么、收了多少钱」），也不属于打手（打手不因为
 * 一张还没接的单发生变化）。它是一次**派单**：一张订单在某个池子里等人接，
 * 过了一个时限就换一种待遇。
 *
 * ## 用户指定的人 ≠ 实际接单的人
 *
 * 这是本模块唯一容易写错的地方，因此把它做成两个永远不会互相覆盖的字段：
 *
 * | 问题 | 字段 | 什么时候写 |
 * |---|---|---|
 * | 用户**指定**过谁 | `exclusiveCompanionId` | 下单那一刻（结算页选的人） |
 * | 实际**接到**这单的是谁 | `acceptedByCompanionId` | 接单那一刻 |
 *
 * 一条真实路径：用户指定 A → A 十分钟内没接 → 自动进公共池 → B 接单。
 * 此时两个字段分别是 A 和 B，**两个事实都要留得住**——管理端与客服以后要能回答
 * 「用户当初想要的人是谁、最后履约的是谁」。
 *
 * 因此：**永不用指定值去填实际值，也永不因为实际值已写就把指定值清空。**
 *
 * ## 没有「拒绝 / 放弃」这条能力
 *
 * 打手不想接专属单时**什么都不做**，十分钟到点系统自动转公共池。
 * 「不接」本身就是拒绝。因此这里**没有** `declinedByCompanionIds` / `declinedAt`，
 * 服务层也没有对应的动作与接口——多了这两个字段，就等于承认存在一条
 * 「主动退回」的写入路径，而那条路径在需求里并不存在。
 */

/**
 * 一张派单当前所在的位置。
 *
 * 四种取值**互斥**，而且「在哪个池」与「有没有被接 / 有没有超时」是同一件事的
 * 两种说法，因此只有一个字段：
 *
 * - `exclusive` —— 在**专属池**里等用户指定的那位打手，固定 10 分钟；
 * - `public`    —— 在**公共池**里等任何一位有资格的打手，时长来自平台配置快照；
 * - `accepted`  —— 已被某位打手接走，两个池都不再接受接单；
 * - `timed_out` —— 派单已关闭，不能再被接单。**两种来路**：公共池到点仍无人接
 *   （P0-5，订单自动全额退款），或**订单在开始服务前被用户直接退款**（P0-12）。
 *
 * ⚠️ `timed_out` 这个名字来自它的第一种来路，但它现在**不只表示超时**；
 * 字段名保留是因为改名要动 P0-5 的持久化语义，而它要表达的事实
 * （`timedOutAt` = 关闭时刻）两种来路都有。展示用的名字见
 * `DISPATCH_STATE_LABELS`，那里是中性的一版。
 *
 * ⚠️ **不要**再另设一个 `poolType` 字段。需求文档里的 `poolType ∈ {exclusive, public}`
 * 就是这个字段在「还没结束时」的两个取值；多一个字段就是多一个真值源，
 * 而它们分叉的那一天，页面上会出现一张既在公共池、又已经被接走的订单。
 */
export type DispatchState = "exclusive" | "public" | "accepted" | "timed_out";

/**
 * 派单记录（仓储内部类型）。
 *
 * 与订单一样，页面与接口**不直接返回本类型**：打手端走 `CompanionPoolItem`，
 * 用户端与管理端读到的是各自 DTO 上的摘要字段。
 */
export type DispatchRecord = {
  id: string;
  orderId: string;
  state: DispatchState;

  /**
   * 用户**指定**的打手；不指定时为 null，订单直接进公共池。
   *
   * ⚠️ 这是**历史事实**，不是当前状态：它记录「用户当初选了谁」。
   * 订单转公共池、被别人接走、甚至超时退款之后，这个值都**保持不变**。
   */
  exclusiveCompanionId: string | null;

  /** 进入专属池的时刻；未指定打手时为 null */
  exclusiveEnteredAt: string | null;
  /** 进入专属池时刻 + 固定等待时长（见 `EXCLUSIVE_WAIT_MINUTES`） */
  exclusiveDeadlineAt: string | null;

  /**
   * 进入公共池的时刻。**每次进入公共池都会重写**：
   * 未指定打手是首次进入，专属池超时是第二次进入——两次都要按**那一刻**的
   * 平台配置重新冻结快照，而不是沿用上一次的截止时间。
   */
  publicPoolEnteredAt: string | null;
  /** 进入公共池时刻 + 当次冻结的超时时长快照 */
  publicDeadlineAt: string | null;
  /**
   * 进入公共池时冻结的那一份「公共池超时」配置值（分钟）。
   *
   * 冻结之后，后台再改参数**不影响这一单**：用户被承诺的是「进入池子时看到的那条规则」。
   * 用今天的配置去重算一张旧订单的截止时间不是「修正」，是把已经承诺的规则事后改掉。
   */
  publicTimeoutMinutesSnapshot: number | null;

  acceptedByCompanionId: string | null;
  acceptedAt: string | null;
  /**
   * **派单关闭的时刻**（`state` 变成 `timed_out` 的那一刻）；没关闭过时为 null。
   *
   * 两种来路都写它：公共池到点无人接，或订单在开始服务前被用户直接退款（P0-12）。
   * 客服端把它显示成「关闭时间」而不是「超时时间」——理由见 `DISPATCH_STATE_LABELS`。
   */
  timedOutAt: string | null;

  createdAt: string;
  updatedAt: string;
};

/* ───────────────────────── 事务层的入参与结果 ───────────────────────── */

/**
 * 一次打手侧写操作的上下文。
 *
 * ⚠️ `companionId` **只允许**来自 `requireCompanion()` 返回的会话身份。
 * 事务层不认识请求体、不认识 Cookie，因此「我是哪位打手」在结构上不可能由调用方声明。
 *
 * `at` 是**服务端时间戳**（ISO 字符串），由服务层取一次后贯穿整段事务：
 * 事务里再取一次 `new Date()` 的话，一次操作里的截止时间判断与写入时间会是两个时刻。
 */
export type CompanionWriteContext = {
  companionId: string;
  at: string;
};

/**
 * 接单的结果。
 *
 * 失败情形**逐个分开**而不是合成一个「接单失败」：它们对打手要说的话完全不同——
 * 「已经被别人接走了」是正常的抢单结果，「你不在这一单的专属池里」是资格问题，
 * 「已经超时」是时限问题。合成一句会让打手对着「接单失败」不知道要不要再试。
 *
 * | 结果 | 含义 | 页面 |
 * |---|---|---|
 * | `ok` | 接单成功，或**你自己**之前已经接过（`replayed` 为 true） | 提示已接单 |
 * | `not-found` | 派单不存在（id 写错 / 已被清理） | 该单已不存在 |
 * | `not-open` | 已经被别人接走，或已经超时关闭 | 该单已被接走 |
 * | `expired` | 你已经看到它，但**在你看的时候它到点了** | 该单已超时 |
 * | `not-eligible` | 专属池，而你不是用户指定的那位 | 你不在这单的专属范围内 |
 * | `companion-unavailable` | 你当前不能接单（资料已下架 / 已移除，或暂停接单） | 联系管理员 |
 * | `order-closed` | 订单本身已不可接取（例如已退款） | 该订单已关闭 |
 * | `self-order` | **这一单是你自己下的**，而一个人不能接自己的单 | 不用再操作，它会继续等别的护航 |
 */
export type DispatchAcceptResult =
  | { kind: "ok"; dispatch: DispatchRecord; replayed: boolean }
  | { kind: "not-found" }
  | { kind: "not-open"; state: DispatchState }
  | { kind: "expired" }
  | { kind: "not-eligible" }
  | { kind: "companion-unavailable" }
  | { kind: "order-closed" }
  | { kind: "self-order" };

/**
 * 接单接口返回给浏览器的结果：事务结果去掉仓储内部记录。
 *
 * ⚠️ **失败的几种情形走 200，不走 4xx**。理由与 `/api/me/companion-application`
 * 「还没有申请返回 `{ application: null }` 而不是 404」完全一样：
 * 「这一单刚被别人接走了」是**正常业务结果**，不是调用出错。
 * 用错误码表达，前端就必须把一个正常分支写成 `catch`，而 `catch` 里分不出
 * 「被抢了」与「网络断了」——前者要刷新页面，后者要重试。
 *
 * 真正属于错误、仍然走 4xx 的只有鉴权：未登录 401、不是打手 / 资格已下架 403
 * （由 `requireCompanion()` 给出）。
 */
export type DispatchAcceptOutcome =
  | { kind: "ok"; dispatchId: string; orderId: string; replayed: boolean }
  | { kind: "not-found" }
  | { kind: "not-open"; state: DispatchState }
  | { kind: "expired" }
  | { kind: "not-eligible" }
  | { kind: "companion-unavailable" }
  | { kind: "order-closed" }
  | { kind: "self-order" };

/* ───────────────────────── 打手端 DTO ───────────────────────── */

/**
 * 池子里的一张订单卡片。
 *
 * ⚠️ **刻意不含 `gameAccountId` 与 `remark`**：那两样是下一个单的用户填的私人信息。
 * 接单**之前**打手没有任何理由看到别人的游戏账号；接单之后看得到，是因为那时
 * 他已经要为这一单负责（那条路径属于后续批次，不在这里开）。
 * 字段是**显式挑出来的**，因此将来给订单加字段不会自动流到池子接口里。
 */
export type CompanionPoolItem = {
  /** 派单 id，接单时提交的就是它 */
  dispatchId: string;
  orderId: string;
  orderNo: string;
  /** 当前所在的池。列表里的单只可能是这两个之一 */
  pool: "exclusive" | "public";
  /** 池子的显示名（文案集中在 `lib/constants/dispatch.ts`） */
  poolLabel: string;

  gameName: string;
  productTitle: string;
  specName: string;
  quantity: number;
  /** 下单（支付成功）时间 */
  paidAt: string;

  /** 当前池子的截止时间 */
  deadlineAt: string;
  /**
   * 距截止还有多少秒，由服务端在读取时算好。
   *
   * ⚠️ 这是**那一刻**的剩余量，不是「到点会自动消失」的倒计时。
   * 它只用于显示；到没到点一律由服务端的 `deadline <= now` 判定，
   * 客户端算出来的数字不参与任何判定。
   */
  remainingSeconds: number;
};

/** 打手端池子页一次要显示的全部内容。 */
export type CompanionPoolData = {
  /**
   * 用户指定给我、还没到点的单。
   *
   * ⚠️ **暂停接单（`available = false`）时这一份仍然返回**：它是**历史事实**
   * （用户当初指定了我），不会因为我现在接不了单就消失。我仍然看得到它、
   * 知道它还剩多久转入公共池，只是不能接。
   */
  exclusive: CompanionPoolItem[];

  /**
   * 谁都能接的单。
   *
   * ⚠️ 暂停接单时**必为空**：不能让他看到一个点下去必然失败的按钮。
   * 这里不是「顺手过滤」——服务层与原子接单区段用的是同一个判定
   * （`isCompanionAcceptingOrders`），因此「列表里没有」与「点了也接不到」永远一致。
   */
  public: CompanionPoolItem[];

  /** 页面上的一句说明（把「不接会怎样」讲清楚；暂停接单时换成暂停的那句） */
  notice: string;

  /**
   * 这位打手此刻能不能接新的单（就是 `available`）。
   *
   * 页面**不自己推断**这件事（不去解析 `notice` 的文案、也不从 `public` 是否为空反推）：
   * 推断出来的结论迟早会与接口的判定分叉，而分叉的那一天，页面上会同时出现
   * 「暂停接单」的提示与一个能点的接单按钮。
   */
  canAccept: boolean;
};
