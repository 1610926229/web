import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import type { Order, OrderStatus } from "@/lib/types/order";
import { addonSeed, companionSeed } from "./seed";

/**
 * 预置订单种子。
 *
 * 用途只有一个：把 P4 还没产生的**其他状态**（已接单 / 护航中 / 已完成 / 已退款）与
 * 各种边界（未绑定打手、长商品名、长规格名、多页分页）补齐，好让订单列表与详情页
 * 在没有真实订单流转的当前阶段也能被完整验收。
 *
 * ⚠️ 与 P4 支付成功动态生成的订单**进的是同一个仓储、同一个 `Map`、同一套查询方法**
 * （`mockPaymentRepository`）。这里不提供任何「预置订单列表」的旁路，
 * 否则「新订单立刻出现在列表顶部」这类行为根本验证不了。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，游戏 ID 等订单信息因此不会进入
 * 浏览器产物。接入真实后端后随 lib/mocks 一并移除。
 *
 * 这里刻意**不复用 `productSeed` 的商品名与价格**：订单要展示的是下单那一刻的快照，
 * 与今天的目录无关。其中一条订单还是已下架商品，用来证明下架不影响历史订单。
 */

type PresetOrderInput = {
  id: string;
  orderNo: string;
  userId: string;
  status: OrderStatus;
  /** 支付时间（ISO）。其余状态节点由它按固定间隔推导，保证时间先后自洽 */
  paidAt: string;

  productId: string;
  productTitle: string;
  productCoverUrl: string;
  specId: string;
  specName: string;
  /** 单位：分 */
  unitPrice: number;
  quantity: number;

  gameName: string;
  region: string;
  gameAccountId: string;
  remark?: string;
  addonIds?: string[];
  /** 不填表示未绑定打手 */
  companionId?: string;
};

function requireCompanion(id: string) {
  const companion = companionSeed.find((item) => item.id === id);
  if (!companion) throw new Error(`Mock 种子缺失陪玩：${id}`);
  return companion;
}

function requireAddon(id: string) {
  const addon = addonSeed.find((item) => item.id === id);
  if (!addon) throw new Error(`Mock 种子缺失增值服务：${id}`);
  return addon;
}

/**
 * 状态时间节点：按支付时间加固定间隔推导，而不是每条订单手写一遍。
 * 手写的时间很容易出现「已完成时间早于支付时间」这种自相矛盾的数据。
 */
function timeline(input: { status: OrderStatus; paidAt: string; hasCompanion: boolean }) {
  const paid = Date.parse(input.paidAt);
  const at = (minutes: number) => new Date(paid + minutes * 60_000).toISOString();
  const paidAt = at(0);

  switch (input.status) {
    case "paid":
      return { paidAt, acceptedAt: null, servingAt: null, completedAt: null, refundedAt: null };
    case "accepted":
      return { paidAt, acceptedAt: at(25), servingAt: null, completedAt: null, refundedAt: null };
    case "serving":
      return { paidAt, acceptedAt: at(25), servingAt: at(60), completedAt: null, refundedAt: null };
    case "completed":
      return {
        paidAt,
        acceptedAt: at(25),
        servingAt: at(60),
        completedAt: at(320),
        refundedAt: null,
      };
    case "refunded":
      // 退款可能发生在接单前（没有陪玩），也可能发生在护航中，两种都保留完整商品与金额快照
      return input.hasCompanion
        ? { paidAt, acceptedAt: at(25), servingAt: at(60), completedAt: null, refundedAt: at(150) }
        : { paidAt, acceptedAt: null, servingAt: null, completedAt: null, refundedAt: at(30) };
  }
}

function build(input: PresetOrderInput): Order {
  const companion = input.companionId ? requireCompanion(input.companionId) : null;

  // 不变量：已接单 / 护航中 / 已完成必须有打手。少了这句话，页面上就会出现
  // 「护航中 · 等待接单」这种自相矛盾的展示，且很难看出是哪条数据写错了。
  const needsCompanion =
    input.status === "accepted" || input.status === "serving" || input.status === "completed";
  if (needsCompanion && !companion) {
    throw new Error(
      `预置订单 ${input.id} 的状态是「${ORDER_STATUS_LABELS[input.status]}」，必须绑定打手`,
    );
  }

  const addons = (input.addonIds ?? []).map((id) => {
    const addon = requireAddon(id);
    // 快照：只复制下单时的名称与价格，之后目录改价不影响历史订单
    return { id: addon.id, name: addon.name, price: addon.price };
  });

  // 金额全程「分」为单位的整数运算
  const itemsAmount = input.unitPrice * input.quantity;
  const addonsAmount = addons.reduce((sum, addon) => sum + addon.price, 0);
  const times = timeline({
    status: input.status,
    paidAt: input.paidAt,
    hasCompanion: companion !== null,
  });

  return {
    id: input.id,
    orderNo: input.orderNo,
    userId: input.userId,
    status: input.status,
    createdAt: times.paidAt,
    paidAt: times.paidAt,
    acceptedAt: times.acceptedAt,
    servingAt: times.servingAt,
    completedAt: times.completedAt,
    refundedAt: times.refundedAt,

    productId: input.productId,
    productTitle: input.productTitle,
    productCoverUrl: input.productCoverUrl,
    specId: input.specId,
    specName: input.specName,
    unitPrice: input.unitPrice,

    quantity: input.quantity,
    gameName: input.gameName,
    region: input.region,
    gameAccountId: input.gameAccountId,
    remark: input.remark ?? "",
    addons,

    itemsAmount,
    addonsAmount,
    totalAmount: itemsAmount + addonsAmount,

    companionId: companion ? companion.id : null,
    companion: companion
      ? { id: companion.id, name: companion.name, avatarUrl: companion.avatarUrl }
      : null,
  };
}

/** 三角洲行动商品的公共字段，省去每条订单重复写一遍游戏名与封面。 */
const DELTA = { gameName: "三角洲行动", region: "手游" };

export const orderSeed: Order[] = [
  // ——————————————————— 老板A（u-1001）：14 条，覆盖五种状态与多页分页 ———————————————————
  build({
    id: "ord-seed-1001-01",
    orderNo: "YM20260912000101",
    userId: "u-1001",
    status: "paid",
    paidAt: "2026-09-12T13:18:00.000Z",
    productId: "p-400w",
    productTitle: "机密400万",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-400w",
    specName: "机密400万",
    unitPrice: 2990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    remark: "晚上八点后有空，随时可以打",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-02",
    orderNo: "YM20260912000102",
    userId: "u-1001",
    status: "paid",
    paidAt: "2026-09-12T05:40:00.000Z",
    productId: "p-600w",
    productTitle: "机密600万",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-600w",
    specName: "机密600万",
    unitPrice: 3990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    // 已付款但已绑定打手：支付时用户主动选了陪玩，还没进入「已接单」
    companionId: "cp-1",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-03",
    orderNo: "YM20260911000103",
    userId: "u-1001",
    status: "accepted",
    paidAt: "2026-09-11T14:05:00.000Z",
    productId: "p-sh300w",
    productTitle: "双护300万（只打巴克）",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-sh500w",
    specName: "双护500万",
    unitPrice: 4590,
    quantity: 1,
    gameAccountId: "moyu_1001",
    companionId: "cp-2",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-04",
    orderNo: "YM20260911000104",
    userId: "u-1001",
    status: "serving",
    paidAt: "2026-09-11T02:30:00.000Z",
    productId: "p-200w",
    productTitle: "机密200万",
    productCoverUrl: "/mock/product-cover-2.svg",
    specId: "s-200w",
    specName: "机密200万",
    unitPrice: 1990,
    quantity: 2,
    gameAccountId: "moyu_1001",
    addonIds: ["ad-voice"],
    companionId: "cp-3",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-05",
    orderNo: "YM20260910000105",
    userId: "u-1001",
    status: "completed",
    paidAt: "2026-09-10T06:12:00.000Z",
    productId: "p-vr-1",
    productTitle: "排位护航（黄金-铂金）",
    productCoverUrl: "/mock/product-cover-3.svg",
    specId: "s-vr-1a",
    specName: "黄金-铂金",
    unitPrice: 4590,
    quantity: 1,
    gameName: "无畏契约",
    region: "端游",
    gameAccountId: "moyu_1001_8899",
    remark: "已经打完了，很稳",
    companionId: "cp-1",
  }),
  build({
    id: "ord-seed-1001-06",
    orderNo: "YM20260909000106",
    userId: "u-1001",
    status: "refunded",
    paidAt: "2026-09-09T11:00:00.000Z",
    productId: "p-vt-1",
    productTitle: "枪法教学",
    productCoverUrl: "/mock/product-cover-2.svg",
    specId: "s-vt-1a",
    specName: "枪法教学 1 小时",
    unitPrice: 2590,
    quantity: 1,
    gameName: "无畏契约",
    region: "端游",
    gameAccountId: "moyu_1001_8899",
    // 接单的打手后来被停用：快照照样完整展示，不受今天的人员状态影响
    companionId: "cp-4",
  }),
  build({
    id: "ord-seed-1001-07",
    orderNo: "YM20260908000107",
    userId: "u-1001",
    status: "paid",
    paidAt: "2026-09-08T09:20:00.000Z",
    productId: "p-speed-1",
    productTitle: "一口气打完一整套",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-speed-1a",
    specName: "标准档",
    unitPrice: 12900,
    quantity: 1,
    gameAccountId: "moyu_1001",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-08",
    orderNo: "YM20260906000108",
    userId: "u-1001",
    status: "completed",
    paidAt: "2026-09-06T07:45:00.000Z",
    productId: "p-fun-2",
    // 长商品名（目录里就是这个名字）：卡片必须能裁切，不能把版式撑坏
    productTitle: "绝密行动（只打巴克什）三小时极速完成不掉段可全程语音",
    productCoverUrl: "/mock/product-cover-3.svg",
    specId: "s-fun-2a",
    specName: "三小时速通",
    unitPrice: 3590,
    quantity: 1,
    gameAccountId: "moyu_1001",
    companionId: "cp-3",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-09",
    orderNo: "YM20260905000109",
    userId: "u-1001",
    status: "paid",
    paidAt: "2026-09-05T03:10:00.000Z",
    productId: "p-off-1",
    // 该商品今天已下架：历史订单照常展示，价格与名称都不受影响
    productTitle: "机密900万",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-900w",
    specName: "机密900万",
    unitPrice: 8990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-10",
    orderNo: "YM20260904000110",
    userId: "u-1001",
    status: "serving",
    paidAt: "2026-09-04T12:00:00.000Z",
    productId: "p-jm200w",
    productTitle: "绝密200万（只打巴克）",
    productCoverUrl: "/mock/product-cover-3.svg",
    // 长规格名：详情与列表都需要能容纳
    specId: "s-jm300w",
    specName: "绝密300万 · 三小时速通（含加急处理与掉段保险）",
    unitPrice: 2990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    addonIds: ["ad-rush", "ad-insure"],
    companionId: "cp-1",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-11",
    orderNo: "YM20260902000111",
    userId: "u-1001",
    status: "accepted",
    paidAt: "2026-09-02T08:30:00.000Z",
    productId: "p-1000w",
    productTitle: "带打1000万",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-1000w",
    specName: "带打1000万",
    unitPrice: 6990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    companionId: "cp-2",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-12",
    orderNo: "YM20260830000112",
    userId: "u-1001",
    status: "completed",
    paidAt: "2026-08-30T05:00:00.000Z",
    productId: "p-800w",
    productTitle: "双护800万",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-800w",
    specName: "双护800万",
    unitPrice: 5990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    companionId: "cp-3",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-13",
    orderNo: "YM20260826000113",
    userId: "u-1001",
    status: "refunded",
    paidAt: "2026-08-26T10:15:00.000Z",
    productId: "p-fun-1",
    productTitle: "娱乐局随便玩",
    productCoverUrl: "/mock/product-cover-2.svg",
    specId: "s-fun-1",
    specName: "娱乐局 1 小时",
    unitPrice: 990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    // 接单前就退款：允许没有打手
    ...DELTA,
  }),
  build({
    id: "ord-seed-1001-14",
    orderNo: "YM20260821000114",
    userId: "u-1001",
    status: "paid",
    paidAt: "2026-08-21T13:50:00.000Z",
    productId: "p-500w",
    productTitle: "绝密500万",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-500w",
    specName: "绝密500万",
    unitPrice: 4990,
    quantity: 1,
    gameAccountId: "moyu_1001",
    remark: "需要开麦，尽量白天",
    addonIds: ["ad-rush", "ad-voice"],
    ...DELTA,
  }),

  // ——————————————————— 老板B（u-1002）：3 条，用于验证两个人互相看不到对方订单 ———————————————————
  build({
    id: "ord-seed-1002-01",
    orderNo: "YM20260912000201",
    userId: "u-1002",
    status: "paid",
    paidAt: "2026-09-12T09:00:00.000Z",
    productId: "p-150w",
    productTitle: "机密150万",
    productCoverUrl: "/mock/product-cover-2.svg",
    specId: "s-150w",
    specName: "机密150万",
    unitPrice: 1490,
    quantity: 1,
    gameAccountId: "moyu_1002",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1002-02",
    orderNo: "YM20260907000202",
    userId: "u-1002",
    status: "completed",
    paidAt: "2026-09-07T04:00:00.000Z",
    productId: "p-400w",
    productTitle: "机密400万",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-400w-2",
    specName: "机密400万 · 双人",
    unitPrice: 3990,
    quantity: 1,
    gameAccountId: "moyu_1002",
    companionId: "cp-3",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1002-03",
    orderNo: "YM20260901000203",
    userId: "u-1002",
    status: "refunded",
    paidAt: "2026-09-01T02:00:00.000Z",
    productId: "p-fun-3",
    productTitle: "带飞一局",
    productCoverUrl: "/mock/product-cover-3.svg",
    specId: "s-fun-3",
    specName: "带飞一局",
    unitPrice: 690,
    quantity: 1,
    gameAccountId: "moyu_1002",
    ...DELTA,
  }),
];
