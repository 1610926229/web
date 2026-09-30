import { ApiError } from "@/lib/api/ApiError";
import { isCompanionAcceptingOrders } from "@/lib/constants/companions";
import { ORDER_DATA_INCONSISTENT_MESSAGE } from "@/lib/constants/dispatch";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  STAFF_ORDER_COMPANION_NOT_FOUND_MESSAGE,
  STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE,
  STAFF_ORDER_NOT_FOUND_MESSAGE,
  STAFF_ORDER_NOT_RELEASABLE_MESSAGE,
  STAFF_ORDER_NOT_REPLACEABLE_MESSAGE,
  STAFF_ORDER_RELEASE_REASON_REQUIRED_MESSAGE,
  STAFF_ORDER_REPLACE_CANDIDATES_NOTICE,
  STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE,
  STAFF_ORDER_REPLACE_EMPTY_DESCRIPTION,
  STAFF_ORDER_SAME_COMPANION_MESSAGE,
  STAFF_ORDER_SELF_ORDER_MESSAGE,
  toStaffOrderReplaceCandidate,
} from "@/lib/constants/staff";
import { readTrimmedString } from "@/lib/constants/writes";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import {
  releaseOrderByStaff,
  replaceOrderCompanionByStaff,
} from "@/lib/data/companionOrderTransaction";
import { ADMIN_ORDER_UNFILTERED_QUERY, getPaymentRepository } from "@/lib/data/paymentRepository";
import type {
  StaffOrderReleaseResult,
  StaffOrderReplaceCandidateListData,
  StaffOrderReplaceResult,
  StaffSessionUser,
} from "@/lib/types/staff";

/**
 * 客服工作台「订单**处置**」服务（P0-11）——换人 / 退回公共池的**唯一**入口。
 *
 * ## 为什么与 `staffOrders.ts` 分开，而不是加进那个文件
 *
 * `staffOrders.ts` 是**只读查询**服务，它的文件头第一条规矩写得很清楚：
 * 「这里没有换人、退款、改状态、写投诉的函数……换人 / 退款属 P0-11 及以后，
 * 它们的入口不在本文件里」。那条边界是 P0-10 刻意画的，本 Round 照它执行：
 * 读与处置分成两个文件，读的那份不需要因为多了一个写动作而重新论证自己的原子性。
 *
 * 与 `staffCompletions.ts`（读 + 写在一个文件里）**刻意不同**：完成材料的读写
 * 属于同一个对象（那份 submission）的同一件事；而订单的读是「全平台任意订单」，
 * 处置是「这一单的履约绑定」，两者的权限面与失效面都不一样。
 *
 * ## 本文件的职责只有三件
 *
 * 1. 校验**请求本身**（原因非空、指定了人）——这是「参数非法」，事务层不该管；
 * 2. 取一个时刻 `at`（一次操作里所有时间字段来自同一个时刻）；
 * 3. 把事务层的结果**逐个**翻成接口错误。
 *
 * 权限（是不是客服）在接口层的 `requireStaff()` 判掉了，本文件**不再判一次**：
 * 同一条规则有两个出处时，两处对同一个请求给出不同答案就没有人说得清哪一处是规则。
 *
 * ⚠️ 本文件**不做任何金额计算、不碰退款**：换人不产生任何资金事件
 * （打手的收益怎么算属后续 Round），因此这里既不读分账字段也不写金额。
 */

/**
 * 把事务层的结果翻译成接口返回。
 *
 * ⚠️ `statusLabel` 用**订单域那一份** `ORDER_STATUS_LABELS`：客服端不另起一套叫法。
 *
 * ⚠️ 入参**只有事务层回给我们的那几个值**，这里不回读订单：
 * 退回公共池的落点状态是常量 `paid`（事务层判过 `canTransitionOrder(…, "paid")`
 * 才可能返回 `ok`），`orderNo` 事务层也已经带回来了。为了拿一个常量去回读一次订单，
 * 会多出一个「写成功、读失败」的对外 404 分支，以及一个两次 `await` 之间的中间态窗口
 * ——而那个窗口正是本项目历史上踩过的形态。
 */
function releaseResult(
  orderId: string,
  orderNo: string,
  releaseRecordId: string,
  at: string,
): StaffOrderReleaseResult {
  return {
    orderId,
    orderNo,
    status: "paid",
    statusLabel: ORDER_STATUS_LABELS.paid,
    releaseRecordId,
    releasedAt: at,
    changed: true,
  };
}

/**
 * 客服把这一单**退回公共池**（`accepted` / `serving` 均可）。
 *
 * ## 失败语义
 *
 * | 结果 | 抛出 | 为什么 |
 * |---|---|---|
 * | 订单不存在 | `NOT_FOUND` → 404 | 与详情接口同一句文案 |
 * | 状态不是 `accepted` / `serving` | `BAD_REQUEST` → 400 | 订单确实存在，只是这个动作此刻不该出现 |
 * | 派单 / 完成材料数据不自洽 | `SERVER_ERROR` → 500 | 不可能状态，且**一笔没写** |
 *
 * ⚠️ **没有幂等键**（与打手取消刻意不同）：客服重复点击时订单已经不在履约中，
 * 走的是 400 那一行，它带的消息正好回答了「这一单现在是什么状态」。
 * 用一个幂等键把第二次点击变成「假装成功」，反而会让客服以为第一次没生效。
 *
 * ⚠️ `reason` 是**必填**（`01-prompt.md` §「Staff re-pool」）。只 trim + 拒绝空串，
 * **没有长度要求**——需求没有冻结字数，写一个上去就等于自己造一条规则，
 * 而事务层并不按它校验。
 */
export async function releaseStaffOrder(
  orderId: string,
  staff: StaffSessionUser,
  body: Record<string, unknown>,
): Promise<StaffOrderReleaseResult> {
  if (!orderId) throw new ApiError("NOT_FOUND", STAFF_ORDER_NOT_FOUND_MESSAGE, 404);

  const reason = readTrimmedString(body, "reason");
  if (!reason) {
    throw new ApiError("BAD_REQUEST", STAFF_ORDER_RELEASE_REASON_REQUIRED_MESSAGE, 400);
  }

  const at = new Date().toISOString();

  const outcome = await releaseOrderByStaff({
    orderId,
    // 触发者**只允许**来自 `requireStaff()` 的会话身份，不来自请求体：
    // 否则任何人都能以别人的名义写一条退出历史
    staffId: staff.id,
    reason,
    at,
  });

  switch (outcome.kind) {
    case "ok": {
      // 事务层的 `ok` 已经同时给了 id、单号与落点时刻，`statusLabel` 是常量文案：
      // 这一格**不需要**任何读取，因此也不该有「读不到」这种失败可能
      return releaseResult(outcome.orderId, outcome.orderNo, outcome.releaseRecordId, outcome.releasedAt);
    }
    case "not-found":
      throw new ApiError("NOT_FOUND", STAFF_ORDER_NOT_FOUND_MESSAGE, 404);
    case "not-releasable":
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_NOT_RELEASABLE_MESSAGE, 400);
    case "dispatch-missing":
    case "inconsistent":
      throw new ApiError("SERVER_ERROR", ORDER_DATA_INCONSISTENT_MESSAGE, 500);
  }
}

/**
 * 客服**直接指定新打手**接替这一单（`accepted` / `serving` 均可）。
 *
 * ## 失败语义
 *
 * | 结果 | 抛出 | 为什么 |
 * |---|---|---|
 * | 订单不存在 | `NOT_FOUND` → 404 | —— |
 * | 状态不是 `accepted` / `serving` | `BAD_REQUEST` → 400 | 这一轮不做「给等待中的单指派打手」 |
 * | 没指定人 / 指定的人不存在 | `BAD_REQUEST` → 400 | 两种都是「这次请求本身不完整」 |
 * | 指定的人此刻不能接单 | `BAD_REQUEST` → 400 | 停用 / 已移除 / 暂停接单，**共用一句** |
 * | 指定的人是下单用户本人 | `BAD_REQUEST` → 400 | 与用户端接单的禁止自接单同一条规则 |
 * | 指定的人正在履约这一单 | `BAD_REQUEST` → 400 | 没有「换」这件事可做 |
 * | 派单 / 完成材料数据不自洽 | `SERVER_ERROR` → 500 | 不可能状态，且**一笔没写** |
 *
 * ⚠️ **不需要管理员审批**（`01-prompt.md` §「Staff direct replace」明文）：
 * 客服的会话身份就是全部授权，本函数不读任何管理端开关、不要求 operationId。
 */
export async function replaceStaffOrderCompanion(
  orderId: string,
  staff: StaffSessionUser,
  body: Record<string, unknown>,
): Promise<StaffOrderReplaceResult> {
  if (!orderId) throw new ApiError("NOT_FOUND", STAFF_ORDER_NOT_FOUND_MESSAGE, 404);

  const companionId = readTrimmedString(body, "companionId");
  if (!companionId) {
    throw new ApiError("BAD_REQUEST", STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE, 400);
  }

  const at = new Date().toISOString();

  const outcome = await replaceOrderCompanionByStaff({
    orderId,
    newCompanionId: companionId,
    staffId: staff.id,
    at,
  });

  switch (outcome.kind) {
    case "ok": {
      // 同 `releaseStaffOrder`：落点状态与文案都是常量，写成功之后的回读只会
      // 多出一个「刚写成功却被报 404」的分支
      return {
        orderId: outcome.orderId,
        orderNo: outcome.orderNo,
        status: "accepted",
        statusLabel: ORDER_STATUS_LABELS.accepted,
        previousCompanionId: outcome.previousCompanionId,
        newCompanionId: outcome.newCompanionId,
        releaseRecordId: outcome.releaseRecordId,
        replacedAt: outcome.replacedAt,
        changed: true,
      };
    }
    case "not-found":
      throw new ApiError("NOT_FOUND", STAFF_ORDER_NOT_FOUND_MESSAGE, 404);
    case "not-replaceable":
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_NOT_REPLACEABLE_MESSAGE, 400);
    case "companion-not-found":
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_COMPANION_NOT_FOUND_MESSAGE, 400);
    case "companion-unavailable":
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE, 400);
    case "self-order":
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_SELF_ORDER_MESSAGE, 400);
    case "same-companion":
      throw new ApiError("BAD_REQUEST", STAFF_ORDER_SAME_COMPANION_MESSAGE, 400);
    case "dispatch-missing":
    case "inconsistent":
      throw new ApiError("SERVER_ERROR", ORDER_DATA_INCONSISTENT_MESSAGE, 500);
  }
}

/**
 * 客服**换人候选名单**：此刻可以指定给这一单的护航。
 *
 * ## 资格过滤全在服务端
 *
 * 复用 `isCompanionAcceptingOrders()`（仓库里「这位护航此刻能不能接新的单」**唯一**的谓词），
 * 再加上两条只属于这个列表的排除：
 *
 * | 排除 | 为什么在这里 | 为什么写在这一层 |
 * |---|---|---|
 * | 下单用户本人 | 事务层会判 `self-order` | 名单里列一个点了必然失败的人，是界面的问题 |
 * | 此刻正在履约这一单的那位 | 事务层会判 `same-companion` | 同上：他不是「可以换的人」 |
 *
 * ⚠️ 后两条是**名单层面的排除**，不是资格规则：它们不改变「谁能接单」的答案，
 * 只改变「这一单上谁值得列出来」。事务层仍然各判一次——名单只是它的一个子集。
 *
 * ⚠️ 订单不存在、或这一单此刻根本没有可换的对象时**报错而不是回空名单**：
 * 回一个空名单会让界面显示「当前没有可指定的护航」，而真实原因是「这一单不该有换人按钮」——
 * 那两句对客服要做的事完全不同。
 */
export async function listStaffOrderReplaceCandidates(
  orderId: string,
): Promise<StaffOrderReplaceCandidateListData> {
  if (!orderId) throw new ApiError("NOT_FOUND", STAFF_ORDER_NOT_FOUND_MESSAGE, 404);

  const order = await getPaymentRepository().findOrderById(orderId);
  if (!order) throw new ApiError("NOT_FOUND", STAFF_ORDER_NOT_FOUND_MESSAGE, 404);

  // 判据与事务层的领域 Guard、以及详情里的 `allowedActions.canReplace` 完全一致
  const inService = order.status === "accepted" || order.status === "serving";
  if (!inService || order.actualCompanionId === null) {
    throw new ApiError("BAD_REQUEST", STAFF_ORDER_NOT_REPLACEABLE_MESSAGE, 400);
  }

  const companions = await getCompanionRepository().listCompanions();
  // 在履约单数一次算好再比对，不逐个护航查一遍订单（N+1）
  const activeCounts = await activeOrderCounts();

  const items = companions
    .filter((companion) => isCompanionAcceptingOrders(companion))
    // ⚠️ 两道排除都在**资格过滤之后**：一位被停用的护航即使正在履约这一单，
    // 也不会因为「他就是当前那位」而被列出来
    .filter((companion) => companion.id !== order.actualCompanionId)
    .filter((companion) => companion.userId === null || companion.userId !== order.userId)
    .map((companion) => toStaffOrderReplaceCandidate(companion, activeCounts.get(companion.id) ?? 0));

  return {
    items,
    notice: items.length === 0 ? STAFF_ORDER_REPLACE_EMPTY_DESCRIPTION : STAFF_ORDER_REPLACE_CANDIDATES_NOTICE,
  };
}

/**
 * 每位护航手上**正在履约**的订单数（`accepted` + `serving`）。
 *
 * ⚠️ 只算这两个状态：`completed` / `refunded` 的订单虽然同样挂着 `actualCompanionId`
 * （那是「谁做的」，不是「谁在做」），但它们不是这位护航手上的活。
 *
 * 订单集合复用 `queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY)`——与
 * `staffOrders.ts` 同一处、同一个共享常量，不为这个列表新开一条订单读取路径。
 */
async function activeOrderCounts(): Promise<Map<string, number>> {
  const orders = await getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
  const counts = new Map<string, number>();

  for (const order of orders) {
    const companionId = order.actualCompanionId;
    if (companionId === null) continue;
    if (order.status !== "accepted" && order.status !== "serving") continue;
    counts.set(companionId, (counts.get(companionId) ?? 0) + 1);
  }

  return counts;
}
