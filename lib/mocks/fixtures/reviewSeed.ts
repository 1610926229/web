import { EVIDENCE_PLACEHOLDER_URL } from "@/lib/constants/evidence";
import type { SupportEvidence } from "@/lib/types/evidence";
import type {
  OrderReview,
  ReviewDimension,
  ReviewRating,
  ReviewStatus,
} from "@/lib/types/review";
import { orderSeed } from "./orderSeed";

/**
 * 预置评价种子（P1-8 双维度模型）。
 *
 * ⚠️ 全部为 Mock 数据：正文统一带「（Mock 文案）」，凭证指向 `public/mock` 下的本地占位图。
 * 任何人都能一眼看出这不是真实用户评价，也不会被当成平台的宣传素材。
 *
 * ## 这些种子是**真实评价记录**，不是数字（`D17`）
 *
 * 陪玩名单（`seed.ts` 的 `companionSeed`）曾经每条都手写着
 * `rating: 4.8, reviewCount: 3, reviews: [...]`。那些数字与用户提交的评价毫无关系：
 * 用户写一条差评，卡片上的分数一动不动。
 *
 * 现在评分的**唯一真值源**是这里的 `OrderReview` 记录：它们关联着真实订单、
 * 有作者、有审核状态，聚合时只计入 `approved`（`D14`）、数量按维度统计（`D15`）、
 * 商品侧与打手侧走同一段代码（`R3`）。
 *
 * ⚠️ 因此**不要**为了「让某个陪玩好看一点」在这里之外的地方调数字——
 * 页面上那个分数是从这些记录算出来的，改数字要改的是记录。
 *
 * ## 快照与身份都从 `orderSeed` 里读出来
 *
 * 订单号 / 商品 / 规格 / 数量 / 完成时间 / 实际履约打手，以及**聚合身份**
 * `productId` / `specId`——全部从订单读，不在这里再手写一遍。手写一份必然与订单数据漂移，
 * 而且很容易造出「评价时间早于订单完成时间」这种自相矛盾、又极难发现的脏数据。
 *
 * ## 种子要覆盖的状态（缺一个就有某个界面看不到）
 *
 * | 想看什么 | 由谁提供 |
 * |---|---|
 * | 打手有真实评分、且**最近 3 条被截断** | `cp-3` 的 4 条 approved |
 * | 打手有真实评分、**不截断**（对照组） | `cp-1` 的 3 条 approved |
 * | 商品有真实评分 | `p-vr-1` / `p-800w` / … |
 * | **暂无评分** | `cp-2`（只被评了商品维度，从没被评打手）与 `cp-8`（完全没有） |
 * | `pending` 不计入公开聚合 | `ord-seed-1004-01` 那条 |
 * | `hidden` 不计入公开聚合、且可被 `unhide` 恢复 | `ord-seed-1008-01` 那条 |
 * | **只评商品**、打手侧 +0 | `u-1001` 在 `ord-seed-1001-15` 上的那条 |
 * | **两个维度都评** | `u-1001` 在 `ord-seed-1001-05` 上的那条 |
 * | **待评价订单**（已完成但没评价） | `ord-seed-1001-08` **刻意不在这里** |
 *
 * ⚠️ 刻意**不种**「`u-1001` 自己的 `pending` / `rejected` / `hidden`」：
 * 这三种状态在验收时由**真实操作**产生（用户提交一条 → 审核中；管理员驳回 → 已驳回；
 * 管理员隐藏 → 已被管理员隐藏）。种出来只能证明「页面会显示这个字符串」，
 * 走一遍才能证明「操作真的把状态改成了它」——而后者才是这一轮要交付的东西。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

/** 一条评价在种子里的一次性写法：只写「作者写了什么」和「审核结果」，其余从订单抄。 */
type PresetReviewInput = {
  id: string;
  userId: string;
  orderId: string;
  /** 商品维度；`null` 表示这一单没评商品 */
  product: { rating: ReviewRating; content: string | null } | null;
  /** 打手维度；`null` 表示这一单没评打手（或这一单没有实际履约打手） */
  companion: { rating: ReviewRating; content: string | null } | null;
  /** 审核状态，默认 `approved`（种子的主要用途是让公开聚合有内容） */
  status?: ReviewStatus;
  /** 提交时间 = 订单完成时间 + 这么多小时。**必须为正**，否则会造出「完成前就评价」的脏数据 */
  hoursAfterCompletion: number;
  evidenceNames?: string[];
  /** 仅 `rejected` 时有值（`D10`：驳回必须写原因） */
  rejectReason?: string;
  /** 仅 `hidden` 时有值（`D10`：隐藏必须写原因） */
  hideReason?: string;
};

/** 审核动作发生在提交之后多少小时。用于让 `reviewedAt` 晚于 `createdAt`。 */
const REVIEW_LEAD_HOURS = 6;

function build(input: PresetReviewInput): OrderReview {
  const order = orderSeed.find((item) => item.id === input.orderId);
  if (!order) throw new Error(`预置评价关联了不存在的订单：${input.orderId}`);

  // 四条不变量：评价只能挂在自己的、已完成的订单上，时间不能早于完成，
  // 且至少要有一个维度。
  // 少了这几句，页面上就会出现「别人订单的评价」「没完成就评价了」「一条什么都
  // 没写的评价」这类无法解释的数据——而且它们在类型上都是合法的，只会在渲染时才露馅。
  if (order.userId !== input.userId) {
    throw new Error(`预置评价 ${input.id} 的用户与订单 ${order.id} 的归属不一致`);
  }
  if (order.status !== "completed" || !order.completedAt) {
    throw new Error(`预置评价 ${input.id} 的订单 ${order.id} 不是已完成状态`);
  }
  if (!input.product && !input.companion) {
    throw new Error(`预置评价 ${input.id} 一个维度都没有（D3：至少一个有效维度）`);
  }
  if (input.companion && !order.companion) {
    throw new Error(`预置评价 ${input.id} 评了打手，但订单 ${order.id} 没有实际履约打手`);
  }
  if (input.hoursAfterCompletion <= 0) {
    throw new Error(`预置评价 ${input.id} 的偏移必须是正数（评价不能早于订单完成）`);
  }

  const status = input.status ?? "approved";
  const createdAt = new Date(
    Date.parse(order.completedAt) + input.hoursAfterCompletion * 60 * 60 * 1000,
  ).toISOString();
  // 审核动作晚于提交：同一秒钟既提交又审完虽然不是不可能，但读起来会让人以为
  // 这两件事是同一件
  const reviewedAt =
    status === "pending"
      ? null
      : new Date(Date.parse(createdAt) + REVIEW_LEAD_HOURS * 60 * 60 * 1000).toISOString();

  const evidence: SupportEvidence[] = (input.evidenceNames ?? []).map((name, index) => ({
    id: `${input.id}-ev-${index + 1}`,
    kind: "image",
    name,
    url: EVIDENCE_PLACEHOLDER_URL,
  }));

  return {
    id: input.id,
    userId: input.userId,
    orderId: order.id,
    orderNo: order.orderNo,

    // 聚合身份（R4）：从订单读，不从商品名反推
    productId: order.productId,
    specId: order.specId,

    productReview: toDimension(input.product),
    companionReview: toDimension(input.companion),
    evidence,

    status,
    // 原因字段与状态严格对齐：`D10` 要求 reject / hide 必填，其余必须为空
    rejectReason: status === "rejected" ? (input.rejectReason ?? "内容不符合规范（Mock）") : null,
    hideReason: status === "hidden" ? (input.hideReason ?? "内容已过期（Mock）") : null,
    // 预置的「审核人」是一个不存在的账号 id：这是 Mock 数据，不该冒充一个真的后台身份。
    // 页面上的文案由 `reviewedByName` 决定，因此这里给得出可读的名字。
    reviewedBy: status === "pending" ? null : "admin-seed",
    reviewedByName: status === "pending" ? null : "系统预置",
    reviewedAt,

    createdAt,
    // 种子没有「重新提交过」，因此两个时间相同；真实的重提会让 updatedAt 前进
    updatedAt: createdAt,

    // 订单快照：提交评价那一刻的值
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    specName: order.specName,
    quantity: order.quantity,
    completedAt: order.completedAt,
    companion: order.companion,
  };
}

function toDimension(
  input: { rating: ReviewRating; content: string | null } | null,
): ReviewDimension | null {
  return input ? { rating: input.rating, content: input.content } : null;
}

/**
 * ⚠️ 每一条都**必须**对应一个真实存在的已完成订单，且一个订单最多一条
 * （`mockReviewRepository.createStore()` 会在建仓时检查重复并抛错）。
 *
 * 订单 → 作者 → 维度的分配是刻意排开的：见上面表格「种子要覆盖的状态」。
 */
export const reviewSeed: OrderReview[] = [
  // ————— 演示用户 u-1001：三种不同的评价形态 —————
  build({
    id: "rev-seed-1001-01",
    userId: "u-1001",
    // **两个维度都评**：这是最常见的一种，也是 D1 双维度模型的主路径
    orderId: "ord-seed-1001-05",
    product: { rating: 5, content: null },
    companion: {
      rating: 5,
      content:
        "打手提前到了几分钟，全程开麦沟通，节奏跟着我走，中途还提醒了两处容易翻车的点。整局很稳，下次还找他。（Mock 文案）",
    },
    hoursAfterCompletion: 1,
    evidenceNames: ["score-board.png"],
  }),
  build({
    id: "rev-seed-1001-02",
    userId: "u-1001",
    orderId: "ord-seed-1001-12",
    product: {
      rating: 4,
      content: "整体符合描述，就是约的时间临时往后挪了一小时。服务本身没问题。（Mock 文案）",
    },
    companion: { rating: 4, content: null },
    hoursAfterCompletion: 2,
    // 没有凭证：凭证是选填的，这一条用来验证列表在无凭证时的版式
  }),
  build({
    id: "rev-seed-1001-03",
    userId: "u-1001",
    // **只评商品**：用来验证「打手侧 +0」——这条既证明只评一个维度是合法的（D3），
    // 也证明 `reviewCount` 数的是维度而不是评价条数（D15）。
    // 它挂在 cp-2 上，因此 cp-2 的详情页应当显示「暂无评分」。
    orderId: "ord-seed-1001-15",
    product: {
      rating: 5,
      content:
        "讲得很细，把我常玩的两个英雄的对线思路重新捋了一遍，还留了练习建议。时间到点也没有催。（Mock 文案）",
    },
    companion: null,
    hoursAfterCompletion: 3,
    evidenceNames: ["note-1.png", "note-2.png"],
  }),

  // ————— cp-3 的另外 3 条 approved：它因此共有 4 条，公开面会被截断（D15） —————
  build({
    id: "rev-seed-1002-01",
    userId: "u-1002",
    // **只评打手**：`ord-seed-1001-15` 那条的镜像用例（那里只评商品）。
    // 两条合起来证明「哪个维度被评，就只给哪一侧计数」
    orderId: "ord-seed-1002-02",
    product: null,
    companion: { rating: 5, content: "接单快，进来就开打，没废话。（Mock 文案）" },
    hoursAfterCompletion: 4,
  }),
  build({
    id: "rev-seed-1005-01",
    userId: "u-1005",
    orderId: "ord-seed-1005-01",
    product: null,
    companion: { rating: 5, content: "第二次找他了，稳定。（Mock 文案）" },
    hoursAfterCompletion: 5,
  }),
  build({
    id: "rev-seed-1006-01",
    userId: "u-1006",
    orderId: "ord-seed-1006-01",
    product: { rating: 5, content: "描述一致，交付时间比说好的还早。（Mock 文案）" },
    companion: { rating: 4, content: null },
    hoursAfterCompletion: 6,
  }),

  // ————— cp-1：3 条 approved —— 「最近 3 条**不**截断」的对照组（D15） —————
  // ⚠️ 这 3 条**不在同一个代码块里**：`rev-seed-1001-01` 在上面「u-1001」那一块。
  // 数一遍时以聚合结果为准（4.7 分 / 3 条），不要只数下面这个块——它只有 2 条。
  build({
    id: "rev-seed-1003-01",
    userId: "u-1003",
    orderId: "ord-seed-1003-01",
    product: null,
    companion: { rating: 5, content: "节奏带得很好，中间有一次网络波动也处理掉了。（Mock 文案）" },
    hoursAfterCompletion: 7,
  }),
  build({
    id: "rev-seed-1004-01",
    userId: "u-1004",
    orderId: "ord-seed-1004-02",
    product: { rating: 5, content: "商品说明很清楚，没有隐藏门槛。（Mock 文案）" },
    companion: { rating: 4, content: null },
    hoursAfterCompletion: 8,
  }),

  // ————— cp-2：只被评商品、从没被评打手 —— 详情页应显示「暂无评分」（D15） —————
  build({
    id: "rev-seed-1003-02",
    userId: "u-1003",
    orderId: "ord-seed-1003-02",
    product: { rating: 5, content: "上分效率很高，两小时打完。（Mock 文案）" },
    companion: null,
    hoursAfterCompletion: 9,
  }),

  // ————— 一条不属于公开面的 pending：证明它**不计入**任何聚合 —————
  build({
    id: "rev-seed-1004-02",
    userId: "u-1004",
    orderId: "ord-seed-1004-01",
    product: { rating: 1, content: "等待时间太久了。（Mock 文案）" },
    companion: { rating: 1, content: null },
    status: "pending",
    hoursAfterCompletion: 10,
  }),

  // ————— 一条 hidden：证明它**不计入**，且可以被管理员 unhide 恢复（D11） —————
  build({
    id: "rev-seed-1008-01",
    userId: "u-1008",
    orderId: "ord-seed-1008-01",
    product: { rating: 5, content: null },
    companion: { rating: 5, content: "这段内容因为 Mock 演示被隐藏了。（Mock 文案）" },
    status: "hidden",
    hideReason: "演示用：这条评价处于隐藏状态（Mock）",
    hoursAfterCompletion: 11,
  }),
];
