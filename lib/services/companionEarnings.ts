import { COMPANION_EARNINGS_NOTICE, EARNING_STATUS_LABELS } from "@/lib/constants/earnings";
import { sweepCompletionAutoApprovals } from "@/lib/data/completionTransaction";
import { sweepMaturedEarnings } from "@/lib/data/earningTransaction";
import { getEarningRepository } from "@/lib/data/earningRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import type {
  CompanionEarningItem,
  CompanionEarningListData,
  Earning,
} from "@/lib/types/earning";

/**
 * 打手「我的收益」读取（P0-9 §九）。
 *
 * ## 只回答「我挣了多少」这一个问题
 *
 * `companionId` 是**查询条件**，不是可选的过滤项：本模块只有一个入口，
 * 而它只可能返回这一位打手自己的收益。服务层不再做一次归属过滤——
 * 那样「谁有权看到哪条收益」就有了两处实现。
 *
 * ## 刻意**没有**的东西
 *
 * - 平台净收入（`clubNetIncome`）：那是平台自己的账，打手端没有任何展示位置；
 * - 其他打手的收益：归属由仓储收窄，本层拿不到；
 * - 订单的其余金额（用户实付、分账比例、累计已退）：打手要回答的是「这一单我挣了多少」，
 *   「用户付了多少、平台抽了几成」是另一件事；
 * - 提现入口、可用余额、钱包流水：本阶段不做（§十三）。
 *
 * ⚠️ DTO 是显式挑字段拼出来的，**不是**把 `Earning` 原样返回：
 * `fineAmount` / `withdrawnAt` 目前是恒定的初始值，带上去只会让两个永远为空的字段
 * 顺着响应流到浏览器，而将来它们有值时「该不该给打手看」还需要单独判断一次——
 * 那时才发现它们早就在响应里了。
 *
 * ⚠️ **P0-13 起 `reversedAmount` 不在「恒定初始值」那一组里了**（退款会写它），
 * 因此它**必须**给打手看：一笔收益被部分冲回后只显示原金额，
 * 打手会以为那笔钱还能全提，而页面上没有任何解释。同时给出**净额**
 * （服务端算好，页面不做减法——金额算术只有一处）。
 */

/**
 * 到期解冻事实的**惰性物化**（幂等，P0-9）。
 *
 * 与用户端 / 打手端订单读路径上的 `materializeCompletionAutoApprovals()` 同一条机制：
 * 解冻不是被定时触发的，而是「`availableAt` 到点且无阻塞就已经成立」，
 * 读取路径只是恰好把它写下来。真实调度器上线后调用**同一个** `sweepMaturedEarnings()`。
 */
function materializeEarningReleases(): void {
  sweepMaturedEarnings(new Date().toISOString());
}

/**
 * 完成事实的惰性物化（P0-8，幂等）。
 *
 * ⚠️ 收益页面**必须先扫这一步**，顺序不能反：一张到期自动通过的订单，
 * 它的收益是在「订单完成」那一刻才产生的。只扫解冻不扫完成的话，
 * 打手会看到一个空页面，而他的单其实早就完成了——「先有完成、才有收益」
 * 这条因果顺序在读取路径上也必须成立。
 */
function materializeCompletionAutoApprovals(): void {
  sweepCompletionAutoApprovals(new Date().toISOString());
}

/**
 * `Earning` + 订单号 → 打手端列表项。
 *
 * ⚠️ `netAmount` 在这里算，**页面不算**（`architecture-rules.md` §三 禁止客户端做金额算术）。
 * 它不落在 `Earning` 上：`incomeAmount - reversedAmount` 是一个可以从两个存储字段
 * 唯一推出来的数，存第三份只会多一个可能对不上的地方。
 */
function toCompanionEarningItem(earning: Earning, orderNo: string): CompanionEarningItem {
  return {
    id: earning.id,
    orderNo,
    orderId: earning.orderId,
    incomeAmount: earning.incomeAmount,
    reversedAmount: earning.reversedAmount,
    netAmount: earning.incomeAmount - earning.reversedAmount,
    status: earning.status,
    // 文案由服务端给：页面不自己维护一份状态名映射
    statusLabel: EARNING_STATUS_LABELS[earning.status],
    frozenAt: earning.frozenAt,
    availableAt: earning.availableAt,
  };
}

/**
 * 某个打手自己的收益列表。
 *
 * 订单号是**从订单上取的**（`Earning` 自己不存订单号）：订单号的展示规则属于订单，
 * 在收益表里再存一份快照意味着两处可能不一致，而「同一个订单在两个页面上号码不同」
 * 会让人以为那是两单。
 *
 * 一次取回这位打手实际履约过的**全部订单**再在本地配对，而不是逐条收益查一次订单：
 * 收益必然产生于他实际履约的订单，因此这一份订单集合一定覆盖所有收益，
 * 而逐条查询在收益变多之后会退化成 N 次查询。
 */
export async function listCompanionEarnings(companionId: string): Promise<CompanionEarningListData> {
  materializeCompletionAutoApprovals();
  materializeEarningReleases();

  const [earnings, orders] = await Promise.all([
    getEarningRepository().listEarningsForCompanion(companionId),
    getPaymentRepository().queryOrdersByCompanion(companionId),
  ]);

  const orderNoById = new Map(orders.map((order) => [order.id, order.orderNo]));

  const items = earnings.map((earning) =>
    // 订单查不到时退回显示订单 id：宁可露出一个 id，也不凭空编一个订单号。
    // 正常路径上取不到这种情况——收益只在订单完成的同一段同步代码里产生，
    // 而全仓没有删除订单的入口
    toCompanionEarningItem(earning, orderNoById.get(earning.orderId) ?? earning.orderId),
  );

  return {
    items,
    summary: {
      // 两个桶分开累计：合成一个「总收益」会让打手以为冻结中的钱现在就能用
      frozenAmount: sumByStatus(items, "frozen"),
      availableAmount: sumByStatus(items, "available"),
      count: items.length,
    },
    notice: COMPANION_EARNINGS_NOTICE,
  };
}

/**
 * 按状态累计金额（分）。
 *
 * ⚠️ **累计的是 `netAmount` 而不是 `incomeAmount`**（P0-13）：这两个合计回答的是
 * 「我现在有多少钱能提」，那就必须是能提的数。用冲回前的原值求和，
 * 页面顶部会显示一个点不出来的数字。原值与冲回额在每条记录上各自可见，
 * 需要解释「为什么少了」时看得到原因。
 *
 * ⚠️ `reversed`（整笔冲销）**不计入任何一个桶**——它的净额本来就是 0；
 * `withdrawn` 同理不计入：本阶段不可达，而真到了可达的那一天，
 * 「已提现的钱算不算我的收益」是一个需要产品回答的问题，不该在这里顺手决定。
 */
function sumByStatus(items: CompanionEarningItem[], status: "frozen" | "available"): number {
  return items
    .filter((item) => item.status === status)
    .reduce((total, item) => total + item.netAmount, 0);
}
