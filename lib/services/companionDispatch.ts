import {
  COMPANION_POOL_NOTICE,
  COMPANION_POOL_PAUSED_NOTICE,
  DISPATCH_POOL_LABELS,
} from "@/lib/constants/dispatch";
import { isCompanionAcceptingOrders } from "@/lib/constants/companions";
import { acceptDispatch, sweepExpiredDispatches, toDispatchProgress } from "@/lib/data/companionDispatchTransaction";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import { getDispatchRepository } from "@/lib/data/dispatchRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import type {
  CompanionPoolData,
  CompanionPoolItem,
  DispatchAcceptOutcome,
  DispatchRecord,
} from "@/lib/types/dispatch";
import type { Order } from "@/lib/types/order";

/**
 * 打手端订单池服务（P0-5）—— 池列表与接单的**唯一**入口。
 *
 * ⚠️ **只被服务端引用**：本模块依赖 `lib/data` 与 `lib/mocks`，
 * 浏览器端取数走 `lib/services/companionHttp.ts`。两者分开是必须的，
 * 否则 Mock 存储与种子数据会被打进浏览器产物。
 *
 * ## 这个模块不判**资格**，但必须判**接单能力**
 *
 * 「他是不是打手」（`enabled` / `removedAt`）只由 `requireCompanion()`（接口）
 * 与工作台壳层（页面）回答，本模块不再查一次：再查一次就是第二个真值来源，
 * 而两处判定分叉的那一天，「资格已下架」会以「池子里空空如也」的样子出现——
 * 最难查的一类 bug。
 *
 * 但 **`available`（当前允不允许接新的订单）必须在**这里被判，而且是两处之一
 * （另一处是原子接单区段）：
 *
 * - 暂停接单的人如果还拿到一份「可接订单」列表，页面就在**承诺一件点下去必然失败的事**。
 *   列表与按钮都不会因此变成真的保护，因此 `acceptDispatch` 里还有一道；
 * - 两处用的是**同一个判定函数**（`isCompanionAcceptingOrders`），因此
 *   「列表里没有」与「点了也接不到」永远一致，不会各说各话。
 *
 * ⚠️ 这两种否定的**处置完全不同**，不要合并：
 * 「资格没了」= 连页面都进不来（`requireCompanion()` 抛 403，壳层渲染提示页）；
 * 「暂停接单」= 进得来、看得到自己的资料，只是接不了新单。
 *
 * ## 谁能看到哪一条
 *
 * - **专属池**：只有 `exclusiveCompanionId` 就是这位打手的单。别人看不到，
 *   因此不会去点一个必然失败的接单按钮（真点了也接不到，见 `acceptDispatch` 第 5 步）。
 *   ⚠️ **暂停接单不改变这一份**：那是「用户当初指定了我」这条历史事实，
 *   我现在接不了单不代表它没发生过。他仍然看得到它、知道它还剩多久转入公共池。
 * - **公共池**：所有**当前能接单**的打手都看得到；暂停接单时**一条都不返回**。
 *   V1 **不做**游戏过滤、商品过滤、等级匹配与智能推荐（需求已明确），
 *   因此这里除了下面两条之外没有任何「挑单」逻辑。
 * - **自己下的单**：两张池子都**不返回**（EX-DISPATCH-08）。一个人不能接自己下的单，
 *   而这张单原本会一字不差地出现在他自己的池子里——池子 DTO 不含 `userId`，
 *   他本来就分不出哪张是自己的。给他看就等于在页面上承诺一件点下去必然失败的事。
 *   ⚠️ 这一条与 `available` 一样是**诚实性**过滤，**不是**保护：真正的拒绝在
 *   `acceptDispatch` 的原子区段里，两处都必须存在，但只有那里是安全边界。
 *
 * ## 池内 DTO 刻意不含游戏账号与备注
 *
 * 那两样是下单用户填的私人信息。接单**之前**，打手没有任何理由看到别人的游戏账号；
 * 字段是在 `toCompanionPoolItem` 里**显式挑出来的**，因此将来给订单加字段
 * 不会自动顺着接口流到池子里。
 */

/**
 * 当前打手能看到的两张池子。
 *
 * ⚠️ **先清扫，再读取**，顺序不能反。反过来的话，一张三分钟前就到点的专属单
 * 会以「还能接」的样子出现在页面上——打手点下去必然被拒，而页面上没有任何
 * 解释（那张单其实早就转进公共池了）。清扫是**同步**的，在第一个 `await` 之前完成。
 *
 * ⚠️ `at` 由调用方传入而**不是在这里取 `new Date()`**：一次读取里
 * 「清扫用什么时刻」与「剩余时间按什么时刻算」必须是同一个时刻，
 * 否则会出现「刚被清扫掉、剩余时间却还是正数」这种自相矛盾的显示。
 * 测试也因此能传入确定的时间，不依赖真实执行日期。
 *
 * ## 顺序：等待最久优先（P0-6.1 FIX-2）
 *
 * 两张池子都是**顶部 = 在各自池子里等得最久的一单**，排序真值分别是
 * `publicPoolEnteredAt` / `exclusiveEnteredAt`（见 `compareByWaitingSince`）。
 * 业务目的是把已经等了较久的老板订单优先暴露给打手。排序**在这里完成**，
 * 页面与接口都不再自己排一次。
 */
export async function listCompanionPools(
  companionId: string,
  at: string,
): Promise<CompanionPoolData> {
  // 把已经到点的派单写成事实（幂等，重复调用与调用一次结果相同）
  sweepExpiredDispatches(at);

  // 这位打手此刻能不能接新的单（`available`）。**读一次，整段用这一份结果**：
  // 列表里的 `canAccept` 与页面上那个按钮必须出自同一次判定
  const companion = await getCompanionRepository().findCompanionById(companionId);
  // 查不到（或已下架 / 已移除）时按「不能接单」处理，而不是当成能接：
  // 走到这里的人本来应该已经被守卫拦下，但把「查不到」当成「可以接」
  // 会让一次数据异常变成一次成功接单
  const canAccept = companion !== null && isCompanionAcceptingOrders(companion);

  const open = await getDispatchRepository().listOpenDispatches();

  // 一次取回订单再按 id 建索引，而不是每条派单查一次：
  // 池子列表的条数不由调用方控制，逐条查就是 N 次查询
  const orders = await getPaymentRepository().listAllOrders();
  const orderById = new Map(orders.map((order) => [order.id, order]));

  // ⚠️ 这里收的是 `{ item, waitingSince }` 而不是裸的条目：排序真值
  // （进入**当前这个池子**的时刻）在派单记录上，而池子 DTO **刻意不含**它
  // ——打手不需要看到「这单是什么时候进的池子」。因此排序键必须在映射成 DTO
  // **之前**就带上，排完再取出 DTO：接口契约一个字段都不用动。
  const exclusive: PoolEntry[] = [];
  const publicPool: PoolEntry[] = [];

  for (const record of open) {
    // 暂停接单：公共池一条都不给。⚠️ 只挡公共池——专属池那一份是历史事实，照常返回
    if (record.state === "public" && !canAccept) continue;

    // 专属池只对**用户指定的那位**可见。这不是「顺手过滤」：
    // 不给他看的单，他不会去点，也就不会撞上一次必然失败的接单
    if (record.state === "exclusive" && record.exclusiveCompanionId !== companionId) continue;

    const order = orderById.get(record.orderId);
    // 订单查不到（或已不在可接状态）时不显示。不猜、不补一条假数据
    if (!order || order.status !== "paid") continue;

    // 自己下的单不进池子（EX-DISPATCH-08）。这与上面两条是**同一性质**的过滤：
    // 「不给他看，他就不会去点一个必然失败的按钮」。
    //
    // ⚠️ 它是**诚实性**，不是安全性。真正的保护只有 `acceptDispatch` 原子区段里那一次
    // 比对；这里少一行会变成「池子里多一张点了必然被拒的单」，而那里少一行就是
    // 一次真的自接单成功。将来若要重构，删这一行是可接受的，删那一道不行。
    //
    // ⚠️ 必须在服务端做：池子 DTO 刻意不含 `userId`（BF-16 / 权限表 §10），
    // 页面上连一个可用的判据都没有。
    //
    // ⚠️ `userId !== null` 与原子区段里的写法**逐字一致**：平台早期的护航资料
    // 没有关联用户（`companionSeed` 的 `cp-*` 大多为 `null`），直接比两个值会把
    // 「没有关联用户的护航」与「没有下单人的订单」判成同一个人（`null === null`），
    // 那是一条凭空消失的订单。（`cp-10` / `cp-11` 起有非空的关联用户，但这道判空
    // 对其它记录仍然必要，因此不能因为「现在有值是常态」就删掉。）
    if (companion !== null && companion.userId !== null && order.userId === companion.userId) {
      continue;
    }

    const progress = toDispatchProgress(record, at);
    if (!progress) continue;

    const item = toCompanionPoolItem(record, order, progress);
    const entry: PoolEntry = { item, waitingSince: currentPoolEnteredAt(record) };
    (progress.pool === "exclusive" ? exclusive : publicPool).push(entry);
  }

  // **等待最久优先**（oldest waiting first）：顶部 = 在**当前这个池子**里等得最久的一单。
  // 两张池子用的是**同一个**比较函数，因为规则是同一条；不同的只是「进入当前池的时刻」
  // 该取哪个字段——那由 `currentPoolEnteredAt` 按记录当前所在的池决定，不在这里各写一份。
  exclusive.sort(compareByWaitingSince);
  publicPool.sort(compareByWaitingSince);

  return {
    // 排完序再取出 DTO：顺序是**服务端的结论**，调用方（页面 / 接口 / HTTP 测试 /
    // 将来的客户端）拿到什么顺序就显示什么顺序，**不再自己 `.sort()`**。
    // 两份排序逻辑迟早会分叉，而分叉的那一天，接口测试与页面看到的是两个不同的池子。
    exclusive: exclusive.map((entry) => entry.item),
    public: publicPool.map((entry) => entry.item),
    notice: canAccept ? COMPANION_POOL_NOTICE : COMPANION_POOL_PAUSED_NOTICE,
    canAccept,
  };
}

/**
 * 派单记录 → 池卡片。**显式挑字段**，不是展开订单。
 *
 * 这里挑的每一个字段都是「决定接不接」用得上的：这是什么游戏、买的什么商品、
 * 什么规格、几单、什么时候付的钱、还剩多久。
 * `gameAccountId` / `remark` / `userId` / 金额明细**一个都不在里面**。
 */
function toCompanionPoolItem(
  record: DispatchRecord,
  order: Order,
  progress: { pool: "exclusive" | "public"; deadlineAt: string; remainingSeconds: number },
): CompanionPoolItem {
  return {
    dispatchId: record.id,
    orderId: order.id,
    orderNo: order.orderNo,
    pool: progress.pool,
    poolLabel: DISPATCH_POOL_LABELS[progress.pool],
    gameName: order.gameName,
    productTitle: order.productTitle,
    specName: order.specName,
    quantity: order.quantity,
    paidAt: order.paidAt,
    deadlineAt: progress.deadlineAt,
    remainingSeconds: progress.remainingSeconds,
  };
}

/**
 * 一张池子条目 + 它的排序键。排序键**不进 DTO**（见收集处的注释）。
 */
type PoolEntry = {
  item: CompanionPoolItem;
  /**
   * 进入**当前这个池子**的时刻，池子排序的唯一真值。
   *
   * `null` 只可能来自「进入池子时没把时刻冻结下来」这种数据异常，见比较函数的处理。
   */
  waitingSince: string | null;
};

/**
 * 这条派单**当前**所在的池子的进入时刻——池子排序的唯一真值。
 *
 * ⚠️ 形状刻意与 `companionDispatchTransaction.ts` 的 `currentDeadlineAt` 一致
 * （按记录当前所在的池取对应的那个字段），因为它们是同一个问题的两个答案：
 * 「这一单现在在哪个池、什么时候进的、什么时候到点」。
 * 在这里另写一套「先看 exclusiveCompanionId 再看 state」之类的判断，就会
 * 在「用户指定过 A、A 没接、已转入公共池」这种记录上和那一处分叉——
 * 那种记录的 `exclusiveEnteredAt` 是**非空**的（历史事实），但它的池子已经是 public。
 * 取错了就是拿「当初进专属池的时刻」去排公共池，一张早就超时转过来的单会插到最前面。
 */
function currentPoolEnteredAt(record: DispatchRecord): string | null {
  return record.state === "exclusive" ? record.exclusiveEnteredAt : record.publicPoolEnteredAt;
}

/**
 * **等待最久优先**（oldest waiting first）：`waitingSince` 升序。
 *
 * ## 为什么不是 `deadlineAt`（本函数的前身 `compareByDeadline`）
 *
 * 两者在「公共池超时时长没被后台改过」时**恰好同序**——因为
 * `publicDeadlineAt = publicPoolEnteredAt + 当次冻结的时长快照`，同一批单的时长一样。
 * 但那是巧合，不是规则：P0-1 起这个时长**后台可配置**，改过之后
 * 一张**更晚**进入池子的订单反而**更早**到点，按 deadline 排就会把它顶到最上面，
 * 「等待最久优先」在配置被改的那一天悄悄失效，而页面上看不出任何异常。
 * 专属池同理（时长虽固定，但规则要的是「谁先进专属池」）。
 *
 * ## 为什么不是 `Order.createdAt`
 *
 * 一张很早创建、被 A 接单、A 又主动取消、今天重新进入公共池的订单（P0-6），
 * 它的等待时间从**这一次**重新进入算起（`applyDispatchToPublic` 会重写
 * `publicPoolEnteredAt`）。用创建时间会把它重新顶到那些真正等了很久的单前面。
 *
 * ## 并列
 *
 * 时刻完全相同（同一毫秒批量写入）时按**派单 id** 排。id 是既有规则，
 * 确定性、不随请求变化、测试可稳定复现——沿用本文件原有的 tie-break，
 * 不引入随机顺序或第二套优先级。
 *
 * `waitingSince` 为 `null`（数据异常）时按**最旧**处理，排在前面而不是丢掉：
 * 丢掉等于让一张确实在池子里的订单从列表上凭空消失，那比顺序不对更难查。
 */
function compareByWaitingSince(a: PoolEntry, b: PoolEntry): number {
  const left = a.waitingSince ?? "";
  const right = b.waitingSince ?? "";
  if (left !== right) return left < right ? -1 : 1;
  return a.item.dispatchId < b.item.dispatchId ? -1 : a.item.dispatchId > b.item.dispatchId ? 1 : 0;
}

/**
 * 接单。
 *
 * ⚠️ 本函数**不判断能不能接**：所有判定（到没到点、是不是指定给他、他还在不在架、
 * 订单有没有被退掉）都在 `acceptDispatch` 的原子区段里做，而且必须在那里做——
 * 判定与写入分开就会留下「判完到写之间被别人抢走」的窗口。
 * 服务层只做一件事：把事务结果转成对外结果。
 *
 * `companionId` **只允许**来自 `requireCompanion()` 返回的会话身份，
 * 不允许来自请求体：否则任何人都能以别人的名义接单。
 */
export async function acceptDispatchForCompanion(
  companionId: string,
  dispatchId: string,
  at: string,
): Promise<DispatchAcceptOutcome> {
  const result = await acceptDispatch(dispatchId, { companionId, at });

  if (result.kind !== "ok") return result;

  return {
    kind: "ok",
    dispatchId: result.dispatch.id,
    orderId: result.dispatch.orderId,
    replayed: result.replayed,
  };
}
