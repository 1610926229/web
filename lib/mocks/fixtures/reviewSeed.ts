import { EVIDENCE_PLACEHOLDER_URL } from "@/lib/constants/evidence";
import type { SupportEvidence } from "@/lib/types/evidence";
import type { OrderReview, ReviewRating } from "@/lib/types/review";
import { orderSeed } from "./orderSeed";

/**
 * 预置评价种子。
 *
 * ⚠️ 全部为 Mock 数据：正文统一带「（Mock 文案）」，凭证指向 `public/mock` 下的本地占位图。
 * 任何人都能一眼看出这不是真实用户评价，也不会被当成平台的宣传素材。
 *
 * 快照（订单号 / 商品 / 规格 / 打手 / 完成时间）**从 `orderSeed` 里读出来**，
 * 而不是在这里再手写一遍：手写一份必然与订单数据漂移，而且很容易造出
 * 「评价时间早于订单完成时间」这种自相矛盾、又极难发现的脏数据。
 *
 * 种子要覆盖的边界：
 * - 已评价记录跨越时间范围（近一月 / 近三月 / 近半年 / 今年各能筛出不同结果）；
 * - 有一单已完成但**没有**评价 → 待评价列表有内容；
 * - 有一条评价**没有凭证**（凭证是选填）；
 * - 老板B 一条评价都没有 → 空态不需要额外的调试开关就能看到。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

type PresetReviewInput = {
  id: string;
  userId: string;
  orderId: string;
  rating: ReviewRating;
  content: string;
  createdAt: string;
  /** 凭证文件名；地址一律写成占位图 */
  evidenceNames?: string[];
};

function build(input: PresetReviewInput): OrderReview {
  const order = orderSeed.find((item) => item.id === input.orderId);
  if (!order) throw new Error(`预置评价关联了不存在的订单：${input.orderId}`);

  // 三条不变量：评价只能挂在自己的、已完成的订单上，且评价时间不能早于完成时间。
  // 少了这几句，页面上就会出现「别人订单的评价」「没完成就评价了」这类无法解释的数据。
  if (order.userId !== input.userId) {
    throw new Error(`预置评价 ${input.id} 的用户与订单 ${order.id} 的归属不一致`);
  }
  if (order.status !== "completed" || !order.completedAt) {
    throw new Error(`预置评价 ${input.id} 的订单 ${order.id} 不是已完成状态`);
  }
  if (Date.parse(input.createdAt) < Date.parse(order.completedAt)) {
    throw new Error(`预置评价 ${input.id} 的评价时间早于订单完成时间`);
  }

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

    rating: input.rating,
    content: input.content,
    evidence,
    createdAt: input.createdAt,

    // 订单快照：提交评价那一刻的值
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    specName: order.specName,
    quantity: order.quantity,
    completedAt: order.completedAt,
    companion: order.companion,
  };
}

export const reviewSeed: OrderReview[] = [
  build({
    id: "rev-seed-1001-01",
    userId: "u-1001",
    // 已完成且未评价的订单（ord-seed-1001-08）**刻意不在这里**：待评价列表要有内容
    orderId: "ord-seed-1001-05",
    rating: 5,
    content:
      "打手提前到了几分钟，全程开麦沟通，节奏跟着我走，中途还提醒了两处容易翻车的点。整局很稳，下次还找他。（Mock 文案）",
    createdAt: "2026-09-10T12:20:00.000Z",
    evidenceNames: ["score-board.png"],
  }),
  build({
    id: "rev-seed-1001-02",
    userId: "u-1001",
    orderId: "ord-seed-1001-12",
    rating: 4,
    content: "整体符合描述，就是约的时间临时往后挪了一小时。服务本身没问题。（Mock 文案）",
    createdAt: "2026-08-31T03:10:00.000Z",
    // 没有凭证：凭证是选填的，这一条用来验证列表在无凭证时的版式
  }),
  build({
    id: "rev-seed-1001-03",
    userId: "u-1001",
    orderId: "ord-seed-1001-15",
    rating: 5,
    content:
      "讲得很细，把我常玩的两个英雄的对线思路重新捋了一遍，还留了练习建议。时间到点也没有催。（Mock 文案）",
    createdAt: "2026-03-21T02:00:00.000Z",
    evidenceNames: ["note-1.png", "note-2.png"],
  }),
];
