import type { TipPaymentStatus, TipRecord } from "@/lib/types/tip";
import { orderSeed } from "./orderSeed";

/**
 * 预置鸡腿记录种子（**只读历史**）。
 *
 * ⚠️ 全部为 Mock 数据：不接支付、不接结算，页面上有明确说明（`TIP_MOCK_NOTICE`）。
 *
 * 记录里**只有鸡腿个数的原始值**，没有任何金额字段：鸡腿的价格、兑换比例、
 * 支付方式与打手结算规则都还没有确认，先写下一个自造的单价，界面与数据都会把它当成事实。
 *
 * 关联订单与打手快照**从 `orderSeed` 里读出来**，而不是在这里再手写一遍：
 * 手写一份必然与订单数据漂移，而且很容易造出「鸡腿记录早于下单时间」这种脏数据。
 *
 * 种子要覆盖的边界：
 * - 三种支付状态各至少一条（状态筛选的每个 chip 都有内容）；
 * - 有一条关联订单**没有绑定打手** → 页面上显示「未绑定」而不是留空；
 * - 老板B 一条记录都没有 → 空态不需要额外的调试开关也能看到。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

type PresetTipInput = {
  id: string;
  userId: string;
  orderId: string;
  /** 鸡腿个数的原始记录值（不是金额） */
  quantity: number;
  paymentStatus: TipPaymentStatus;
  createdAt: string;
};

function build(input: PresetTipInput): TipRecord {
  const order = orderSeed.find((item) => item.id === input.orderId);
  if (!order) throw new Error(`预置鸡腿记录关联了不存在的订单：${input.orderId}`);

  // 两条不变量：记录只能挂在自己的订单上，且不能早于下单时间
  if (order.userId !== input.userId) {
    throw new Error(`预置鸡腿记录 ${input.id} 的用户与订单 ${order.id} 的归属不一致`);
  }
  if (Date.parse(input.createdAt) < Date.parse(order.paidAt)) {
    throw new Error(`预置鸡腿记录 ${input.id} 的时间早于订单支付时间`);
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error(`预置鸡腿记录 ${input.id} 的数量必须是正整数`);
  }

  return {
    id: input.id,
    userId: input.userId,

    // 订单快照：记录创建那一刻的值，之后订单改名、打手改名都不影响这里
    orderId: order.id,
    orderNo: order.orderNo,
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    companion: order.companion,

    quantity: input.quantity,
    paymentStatus: input.paymentStatus,
    createdAt: input.createdAt,
  };
}

export const tipSeed: TipRecord[] = [
  build({
    id: "tip-seed-1001-01",
    userId: "u-1001",
    orderId: "ord-seed-1001-05",
    quantity: 2,
    paymentStatus: "paid",
    createdAt: "2026-09-11T13:00:00.000Z",
  }),
  build({
    id: "tip-seed-1001-02",
    userId: "u-1001",
    orderId: "ord-seed-1001-08",
    quantity: 1,
    paymentStatus: "paid",
    createdAt: "2026-09-07T09:00:00.000Z",
  }),
  build({
    id: "tip-seed-1001-03",
    userId: "u-1001",
    // 已付款但还没绑定打手的订单：记录照样完整，页面显示「未绑定」
    orderId: "ord-seed-1001-01",
    quantity: 1,
    paymentStatus: "failed",
    createdAt: "2026-09-12T14:00:00.000Z",
  }),
  build({
    id: "tip-seed-1001-04",
    userId: "u-1001",
    orderId: "ord-seed-1001-02",
    quantity: 3,
    paymentStatus: "pending",
    createdAt: "2026-09-12T06:00:00.000Z",
  }),
];
