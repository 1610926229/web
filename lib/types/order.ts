/**
 * 订单类型。
 *
 * 本阶段只产生「已付款」订单：接单与平台分配属于后续阶段，完成后才会写入 `companionId`
 * 并进入「已接单」，因此这里的状态联合目前只有一项——等后续阶段真正需要时再扩展，
 * 不提前造出一堆用不到的状态。
 */
export type OrderStatus = "paid";

/** 增值服务快照：下单时的名称与价格，之后目录改名改价不影响历史订单。 */
export type OrderAddonSnapshot = {
  id: string;
  name: string;
  /** 单位：分 */
  price: number;
};

/** 陪玩公开信息快照。未选择陪玩时整项为 null。 */
export type OrderCompanionSnapshot = {
  id: string;
  name: string;
  avatarUrl: string;
};

/**
 * 订单。
 *
 * 商品名称、图片、规格名称、单价与陪玩公开信息都是**下单那一刻的快照**：
 * 之后改价、换图、陪玩改名，历史订单展示与金额都不受影响。
 *
 * 金额一律是「分」为单位的整数，且**只由服务端计算写入**——客户端提交的任何金额字段都被忽略。
 */
export type Order = {
  id: string;
  /** 展示用订单号 */
  orderNo: string;
  userId: string;
  status: OrderStatus;
  createdAt: string;
  paidAt: string;

  // —— 下单内容快照 ——
  productId: string;
  productTitle: string;
  productCoverUrl: string;
  specId: string;
  specName: string;
  /** 单位：分 */
  unitPrice: number;

  quantity: number;
  region: string;
  gameAccountId: string;
  remark: string;
  addons: OrderAddonSnapshot[];

  // —— 金额（服务端计算）——
  /** 单价 × 数量 */
  itemsAmount: number;
  /** 增值服务合计（按单计费，不随数量变化） */
  addonsAmount: number;
  totalAmount: number;

  /**
   * 用户主动选择的陪玩；未选择时为 null。
   * 「已选择」不等于「已接单」：支付成功后的初始状态同样是「已付款」，
   * 写入 `companionId` 与进入「已接单」都由后续阶段的接单/分配完成。
   */
  companionId: string | null;
  companion: OrderCompanionSnapshot | null;
};
