import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  beijingDayStart,
  beijingMonthStart,
  beijingWeekStart,
} from "@/lib/constants/rankingPeriods";
import type { Order, OrderStatus } from "@/lib/types/order";
import { addonSeed } from "./catalogSeed";
import { companionSeed } from "./seed";

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

/**
 * 「已完成」订单的完成时间相对支付时间的偏移（分钟）。
 *
 * 单独拎出来是因为它有两个使用方：`timeline()` 由支付时间推完成时间；
 * 下面的周期榜预置数据反过来——先定下完成时间（要落在某个周期的区间里），
 * 再由它倒推支付时间。两边必须用同一个数，否则构造出来的订单自相矛盾。
 */
const COMPLETION_LEAD_MINUTES = 320;

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
        completedAt: at(COMPLETION_LEAD_MINUTES),
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
      // 订单快照的字段名保持 `name`（订单与评价的历史展示都按它读），值取陪玩唯一的昵称字段
      ? { id: companion.id, name: companion.displayName, avatarUrl: companion.avatarUrl }
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

  build({
    id: "ord-seed-1001-15",
    orderNo: "YM20260320000115",
    userId: "u-1001",
    status: "completed",
    // 一条**更早**的已完成订单：评价页的时间筛选（近一月 / 近三月 / 近半年 / 今年）
    // 需要有跨越时间范围的记录才能被验收，「评价早于订单完成」又不能出现，
    // 因此这里补一条足够早的订单，而不是去改已有订单的时间。
    paidAt: "2026-03-20T06:00:00.000Z",
    productId: "p-vt-2",
    productTitle: "英雄池扩展指导",
    productCoverUrl: "/mock/product-cover-2.svg",
    specId: "s-vt-2",
    specName: "英雄池指导 2 小时",
    unitPrice: 3290,
    quantity: 1,
    gameName: "无畏契约",
    region: "端游",
    gameAccountId: "moyu_1001_8899",
    companionId: "cp-2",
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

  // ————————————— 排行榜用户（u-1003 ~ u-1010）：为消费排行榜补的已完成订单 —————————————
  //
  // 为什么必须补：消费排行榜要聚合**全部用户**的已完成订单，只有两位用户时
  // 造不出「前三名 + 普通列表」，也造不出「金额相同的两个人」「有订单但有效消费为 0 的人」
  // 这些必须被验收到的边界。这些订单与前面的订单进的是**同一个仓储、同一个 Map**，
  // 因此排行榜聚合、消费等级页与订单列表看到的是同一份数据。
  //
  // 各用户的有效消费金额（分）刻意设置如下：
  //   u-1003 = 59880（高级老板，距金牌老板只差 120 分）
  //   u-1004 = 114800（金牌老板）
  //   u-1005 = 59700
  //   u-1006 = 30000 ┐ 同为 30000，用来验证「金额相同时按用户 id 升序」的稳定排序
  //   u-1007 = 30000 ┘
  //   u-1008 = 8880
  //   u-1009 = 0（一单已退款、一单还在进行中）→ 不进入排行榜
  //   u-1010 没有任何订单 → 不进入排行榜

  build({
    id: "ord-seed-1003-01",
    orderNo: "YM20260828000301",
    userId: "u-1003",
    status: "completed",
    paidAt: "2026-08-28T06:00:00.000Z",
    productId: "p-1200w",
    productTitle: "带打1200万（含全程语音陪玩）",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-1200w",
    specName: "带打1200万",
    unitPrice: 39900,
    quantity: 1,
    gameAccountId: "moyu_1003",
    companionId: "cp-1",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1003-02",
    orderNo: "YM20260818000302",
    userId: "u-1003",
    status: "completed",
    paidAt: "2026-08-18T06:00:00.000Z",
    productId: "p-speed-2",
    productTitle: "全天包时段",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-speed-2",
    specName: "全天包时段",
    unitPrice: 19980,
    quantity: 1,
    gameAccountId: "moyu_1003",
    companionId: "cp-2",
    ...DELTA,
  }),

  build({
    id: "ord-seed-1004-01",
    orderNo: "YM20260903000401",
    userId: "u-1004",
    status: "completed",
    paidAt: "2026-09-03T06:00:00.000Z",
    productId: "p-speed-1",
    productTitle: "一口气打完一整套",
    productCoverUrl: "/mock/product-cover-3.svg",
    specId: "s-speed-1b",
    specName: "加急档",
    unitPrice: 89900,
    quantity: 1,
    gameAccountId: "moyu_1004",
    companionId: "cp-3",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1004-02",
    orderNo: "YM20260824000402",
    userId: "u-1004",
    status: "completed",
    paidAt: "2026-08-24T06:00:00.000Z",
    productId: "p-vr-2",
    productTitle: "排位护航（钻石-超凡）",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-vr-2",
    specName: "钻石-超凡",
    unitPrice: 19900,
    quantity: 1,
    gameName: "无畏契约",
    region: "端游",
    gameAccountId: "moyu_1004_7788",
    companionId: "cp-1",
  }),
  build({
    id: "ord-seed-1004-03",
    orderNo: "YM20260810000403",
    userId: "u-1004",
    status: "completed",
    paidAt: "2026-08-10T06:00:00.000Z",
    productId: "p-fun-5",
    productTitle: "四人车队整活",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-fun-5",
    specName: "四人车队 1 小时",
    unitPrice: 5000,
    quantity: 1,
    gameAccountId: "moyu_1004",
    addonIds: ["ad-voice"],
    companionId: "cp-2",
    ...DELTA,
  }),

  build({
    id: "ord-seed-1005-01",
    orderNo: "YM20260901000501",
    userId: "u-1005",
    status: "completed",
    paidAt: "2026-09-01T06:00:00.000Z",
    productId: "p-1200w",
    productTitle: "带打1200万（含全程语音陪玩）",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-1200w",
    specName: "带打1200万",
    unitPrice: 39900,
    quantity: 1,
    gameAccountId: "moyu_1005",
    companionId: "cp-3",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1005-02",
    orderNo: "YM20260822000502",
    userId: "u-1005",
    status: "completed",
    paidAt: "2026-08-22T06:00:00.000Z",
    productId: "p-speed-2",
    productTitle: "全天包时段",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-speed-2",
    specName: "全天包时段",
    unitPrice: 9900,
    quantity: 1,
    gameAccountId: "moyu_1005",
    companionId: "cp-1",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1005-03",
    orderNo: "YM20260808000503",
    userId: "u-1005",
    status: "completed",
    paidAt: "2026-08-08T06:00:00.000Z",
    productId: "p-vr-1",
    productTitle: "排位护航（黄金-铂金）",
    productCoverUrl: "/mock/product-cover-2.svg",
    specId: "s-vr-1a",
    specName: "黄金-铂金",
    unitPrice: 9900,
    quantity: 1,
    gameName: "无畏契约",
    region: "端游",
    gameAccountId: "moyu_1005_6612",
    companionId: "cp-2",
  }),

  build({
    id: "ord-seed-1006-01",
    orderNo: "YM20260830000601",
    userId: "u-1006",
    status: "completed",
    // 正好 30000 分 = 「高级老板」的阈值：用来验收「用户正好达到阈值」
    paidAt: "2026-08-30T06:00:00.000Z",
    productId: "p-600w",
    productTitle: "机密600万",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-600w",
    specName: "机密600万",
    unitPrice: 30000,
    quantity: 1,
    gameAccountId: "moyu_1006",
    companionId: "cp-3",
    ...DELTA,
  }),

  build({
    id: "ord-seed-1007-01",
    orderNo: "YM20260829000701",
    userId: "u-1007",
    status: "completed",
    paidAt: "2026-08-29T06:00:00.000Z",
    productId: "p-300w",
    productTitle: "机密300万（限时折扣）",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-300w",
    specName: "机密300万",
    unitPrice: 15000,
    quantity: 1,
    gameAccountId: "moyu_1007",
    companionId: "cp-1",
    ...DELTA,
  }),
  build({
    id: "ord-seed-1007-02",
    orderNo: "YM20260815000702",
    userId: "u-1007",
    status: "completed",
    // 与 u-1006 的有效消费完全相同：验证「金额相同时的确定性第二排序条件」
    paidAt: "2026-08-15T06:00:00.000Z",
    productId: "p-300w",
    productTitle: "机密300万（限时折扣）",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-300w-2",
    specName: "机密300万 · 双人",
    unitPrice: 15000,
    quantity: 1,
    gameAccountId: "moyu_1007",
    companionId: "cp-2",
    ...DELTA,
  }),

  build({
    id: "ord-seed-1008-01",
    orderNo: "YM20260812000801",
    userId: "u-1008",
    status: "completed",
    paidAt: "2026-08-12T06:00:00.000Z",
    productId: "p-fun-4",
    productTitle: "新手教学陪玩",
    productCoverUrl: "/mock/product-cover-4.svg",
    specId: "s-fun-4",
    specName: "教学陪玩 2 小时",
    unitPrice: 8880,
    quantity: 1,
    gameAccountId: "moyu_1008",
    companionId: "cp-3",
    ...DELTA,
  }),

  // u-1009：有订单但**有效消费为 0**。这一条是排行榜的关键边界——
  // 「有订单」不等于「有效消费」，已退款与进行中的订单都不计入。
  build({
    id: "ord-seed-1009-01",
    orderNo: "YM20260820000901",
    userId: "u-1009",
    status: "refunded",
    paidAt: "2026-08-20T06:00:00.000Z",
    productId: "p-vt-1",
    productTitle: "枪法教学",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-vt-1a",
    specName: "枪法教学 1 小时",
    unitPrice: 25900,
    quantity: 1,
    gameName: "无畏契约",
    region: "端游",
    gameAccountId: "moyu_1009_5501",
    companionId: "cp-1",
  }),
  build({
    id: "ord-seed-1009-02",
    orderNo: "YM20260910000902",
    userId: "u-1009",
    status: "paid",
    paidAt: "2026-09-10T06:00:00.000Z",
    productId: "p-150w",
    productTitle: "机密150万",
    productCoverUrl: "/mock/product-cover-2.svg",
    specId: "s-150w",
    specName: "机密150万",
    unitPrice: 2990,
    quantity: 1,
    gameAccountId: "moyu_1009",
    ...DELTA,
  }),
];

/* ────────────────────── 周期榜的相对时间预置订单 ────────────────────── */

/**
 * 周期榜（今日 / 昨日 / 本周 / 本月 / 上月）的预置订单，**按传入的 `now` 相对构造**。
 *
 * 上面的 `orderSeed` 用的是写死的绝对日期，那是为了「订单列表有历史数据可看」。
 * 周期榜不能照抄这个做法：写死某一天，第二天「今日」就永远是空的，
 * 人工验收看到的是一张空榜，而不是一个坏掉的页签——问题会一直藏着。
 *
 * 因此这里从 `now` 出发，按**北京时间的自然日 / 自然周 / 自然月**分摊：
 *
 * | 落在哪个区间 | 用户 | 完成时间（北京时间） | 金额（分） |
 * | --- | --- | --- | --- |
 * | 今日 | u-1001 / u-1011 / u-1012 | 今天 10:00 / 12:00 / 09:00（晚于「现在」则夹到此刻之前） | 6600 / 12000 / 6600 |
 * | 昨日 | u-1013 / u-1017 | 昨天 15:00 / 18:00 | 25500 / 8600 |
 * | 本周 | u-1014 / u-1018 | 本周一 15:00 / 11:00（周一当天则夹到此刻之前） | 9000 / 14500 |
 * | 本月 | u-1015 / u-1019 | 本月 1 日 15:00 / 本月 2 日 15:00（同理） | 18900 / 3300 |
 * | 上月 | u-1016 / u-1020 / u-1021 | 上月 15 日 / 20 日 / 8 日 15:00 | 13700 / 28800 / 13700 |
 *
 * **每个周期的数据都只来自这张表**，不依赖 `orderSeed` 里那些绝对日期订单，
 * 因此换一个月、跨一年、遇到闰年二月，六档榜单都还是这几位用户——
 * 绝对日期订单只会**额外**出现在「累计」（以及它恰好在的那个周期）里，滚出去了也不影响任何一档。
 * `tests/rankings.test.mjs` 里有一条守卫用例：把绝对订单全部去掉，六个周期仍然各自有数据，
 * 且这些用户与金额与带绝对订单时完全一致。
 *
 * 另外几处是刻意留的边界：
 *
 * - **今日的 u-1001 与 u-1012 金额完全相同（66.00）**、**上月的 u-1016 与 u-1021 完全相同（137.00）**：
 *   验证同一周期内金额相同时按用户 id 升序的第二排序条件真的生效，名次不漂移；
 * - **上月 8 日 / 20 日**：二月的 8 日与 20 日都一定存在，闰年 29 天也不会越界；
 * - **十一位用户里只有 u-1001 出现在 `orderSeed` 中**，因此既有的累计口径断言
 *   （等级门槛、同金额并列、零消费用户）全部保持原样。
 *
 * 不变量：返回的每一条都是 `completed`、都有打手、金额都大于 0、订单号与 id 都不与既有种子重复，
 * 且**完成时间不晚于 `now`**（不造未来时间）。整个过程纯函数，相同 `now` 得到相同结果。
 */
export function buildRankingPeriodOrders(now: Date): Order[] {
  const nowMs = now.getTime();
  const HOUR_MS = 60 * 60_000;
  const DAY_HOURS = 24;

  /** 北京时间「`base` 这一天再加 `hours` 小时」。 */
  const at = (base: number, hours: number) => base + hours * HOUR_MS;

  /**
   * 把时刻夹进它所属的那一段（当天 / 本周 / 本月）：不早于区间起点，也不晚于「现在」。
   *
   * 起点用「左闭」的边界值：正好落在 00:00 也算这一段。上限取 `now - 1ms`
   * 而不是 `now`——榜单区间是左闭右开的 `[start, now)`，
   * 完成时间正好等于右端会被排除在外。
   */
  const clampToPeriod = (desired: number, periodStart: number) =>
    Math.min(Math.max(desired, periodStart), Math.max(periodStart, nowMs - 1));

  const todayStart = beijingDayStart(now);
  const yesterdayStart = beijingDayStart(now, -1);
  const weekStart = beijingWeekStart(now);
  const monthStart = beijingMonthStart(now);
  const lastMonthStart = beijingMonthStart(now, -1);

  /**
   * 上月的第 `day` 天 15:00。
   *
   * 上月至少 28 天，因此 `day ≤ 28` 时一定落在上月之内；这里只用 8 / 15 / 20 三个日期。
   * 上月已经结束，它的任何时刻都早于「现在」，不需要夹。
   */
  const lastMonthDay = (day: number) => at(lastMonthStart, (day - 1) * DAY_HOURS + 15);

  const presets = [
    {
      // 今日 10:00：本次验收的登录用户，用来验证「我的排名」随周期变化
      id: "ord-rank-today-1001",
      orderNo: "YMRANKTODAY1001",
      userId: "u-1001",
      unitPrice: 6600,
      completedAtMs: clampToPeriod(at(todayStart, 10), todayStart),
    },
    {
      // 今日 12:00：今日第一名
      id: "ord-rank-today-1011",
      orderNo: "YMRANKTODAY1011",
      userId: "u-1011",
      unitPrice: 12000,
      completedAtMs: clampToPeriod(at(todayStart, 12), todayStart),
    },
    {
      // 今日 09:00：与 u-1001 同额，验证同周期内的稳定排序
      id: "ord-rank-today-1012",
      orderNo: "YMRANKTODAY1012",
      userId: "u-1012",
      unitPrice: 6600,
      completedAtMs: clampToPeriod(at(todayStart, 9), todayStart),
    },
    {
      // 昨日 15:00：应出现在「昨日」与（昨天属于本周时的）「本周」，不出现在「今日」
      id: "ord-rank-yesterday-1013",
      orderNo: "YMRANKYESTERDAY1013",
      userId: "u-1013",
      unitPrice: 25500,
      completedAtMs: at(yesterdayStart, 15),
    },
    {
      // 昨日 18:00：昨日第二名，证明这一档不是只有一个人
      id: "ord-rank-yesterday-1017",
      orderNo: "YMRANKYESTERDAY1017",
      userId: "u-1017",
      unitPrice: 8600,
      completedAtMs: at(yesterdayStart, 18),
    },
    {
      // 本周一 15:00：应出现在「本周」「本月」，不一定是「今日」
      id: "ord-rank-week-1014",
      orderNo: "YMRANKWEEK1014",
      userId: "u-1014",
      unitPrice: 9000,
      completedAtMs: clampToPeriod(at(weekStart, 15), weekStart),
    },
    {
      // 本周一 11:00：本周第一名
      id: "ord-rank-week-1018",
      orderNo: "YMRANKWEEK1018",
      userId: "u-1018",
      unitPrice: 14500,
      completedAtMs: clampToPeriod(at(weekStart, 11), weekStart),
    },
    {
      // 本月 1 日 15:00：应出现在「本月」，不一定是「本周」
      id: "ord-rank-month-1015",
      orderNo: "YMRANKMONTH1015",
      userId: "u-1015",
      unitPrice: 18900,
      completedAtMs: clampToPeriod(at(monthStart, 15), monthStart),
    },
    {
      // 本月 2 日 15:00：本月里的第二位用户；月初当天会被夹到此刻之前，仍在「本月」内
      id: "ord-rank-month-1019",
      orderNo: "YMRANKMONTH1019",
      userId: "u-1019",
      unitPrice: 3300,
      completedAtMs: clampToPeriod(at(monthStart, DAY_HOURS + 15), monthStart),
    },
    {
      // 上月 15 日 15:00：上月第二名（与 u-1021 同额，按 id 升序排在前）
      id: "ord-rank-lastmonth-1016",
      orderNo: "YMRANKLASTMONTH1016",
      userId: "u-1016",
      unitPrice: 13700,
      completedAtMs: lastMonthDay(15),
    },
    {
      // 上月 20 日 15:00：上月第一名
      id: "ord-rank-lastmonth-1020",
      orderNo: "YMRANKLASTMONTH1020",
      userId: "u-1020",
      unitPrice: 28800,
      completedAtMs: lastMonthDay(20),
    },
    {
      // 上月 8 日 15:00：与 u-1016 同额
      id: "ord-rank-lastmonth-1021",
      orderNo: "YMRANKLASTMONTH1021",
      userId: "u-1021",
      unitPrice: 13700,
      completedAtMs: lastMonthDay(8),
    },
  ];

  return presets.map((preset) =>
    build({
      id: preset.id,
      orderNo: preset.orderNo,
      userId: preset.userId,
      status: "completed",
      // 先定完成时间再由它倒推支付时间：与 `timeline()` 是同一个偏移，时间轴自洽
      paidAt: new Date(preset.completedAtMs - COMPLETION_LEAD_MINUTES * 60_000).toISOString(),
      productId: "p-400w",
      productTitle: "机密400万",
      productCoverUrl: "/mock/product-cover-1.svg",
      specId: "s-400w",
      specName: "机密400万",
      unitPrice: preset.unitPrice,
      quantity: 1,
      gameAccountId: `moyu_${preset.userId.slice(2)}`,
      companionId: "cp-1",
      ...DELTA,
    }),
  );
}
