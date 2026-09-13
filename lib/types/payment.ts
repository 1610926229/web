/**
 * 结算与支付类型。
 *
 * 贯穿始终的一条规则：**金额只由服务端计算**。
 * `CheckoutSelection`（用户选了什么）与金额严格分开，接口输入里根本没有价格字段可填。
 */
import type { Addon } from "./catalog";
import type { OrderAddonSnapshot, OrderCompanionSnapshot } from "./order";

/** 支付请求状态。`pending` 是唯一的非终态；终态不会再改变。 */
export type PaymentStatus = "pending" | "success" | "failed" | "cancelled";

/** 模拟支付可确认的三种结果，仅用于本地开发验证。 */
export type MockPaymentResult = "success" | "failure" | "cancel";

/**
 * 结算页的业务选择：**只有用户的选择，没有任何金额字段**。
 * 大区取值来自商品所属游戏；游戏 ID 与备注也在这里，但它们的校验发生在正式下单时。
 */
export type CheckoutSelection = {
  productId: string;
  specId: string;
  quantity: number;
  region: string;
  addonIds: string[];
  gameAccountId: string;
  remark: string;
  /** 选填；未选择时为 null，订单等待后续接单或平台分配 */
  companionId: string | null;
};

/**
 * 服务端试算结果。
 *
 * 客户端展示的金额**只认这一份**：它是服务端按商品、规格、数量与增值服务算出来的，
 * 客户端不做任何加减，也不缓存成「可信金额」。
 */
export type CheckoutPreview = {
  product: { id: string; title: string; subtitle: string; coverUrl: string };
  spec: { id: string; name: string; price: number };
  quantity: number;
  addons: Addon[];
  /** 单价 × 数量 */
  itemsAmount: number;
  /** 增值服务合计，按单计费，不随数量变化 */
  addonsAmount: number;
  totalAmount: number;
};

/**
 * 下单内容快照：在**创建支付请求**时就把商品名称、图片、规格名、单价、增值服务与
 * 陪玩公开信息固定下来。
 *
 * 提前到创建时取快照，是为了让「金额」和「订单上展示的内容」同源：
 * 支付成功生成订单时直接复制，不会出现「单价 × 数量 ≠ 商品金额」这种自相矛盾的订单。
 */
export type PaymentRequestSnapshot = {
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  unitPrice: number;
  addons: OrderAddonSnapshot[];
  companion: OrderCompanionSnapshot | null;
};

/**
 * 支付请求。
 *
 * 创建它的瞬间就把「用户选了什么 + 服务端算出多少钱」固定下来，之后正式支付时
 * 服务端会**重新完整校验并重算一次**，不会直接信任此前任何一次试算结果。
 *
 * `idempotencyKey` 与 `userId` 组成唯一约束：同一次提交的重试只会得到同一条记录。
 * `snapshot` 是内部字段，不对客户端返回。
 */
export type PaymentRequest = CheckoutSelection & {
  id: string;
  userId: string;
  idempotencyKey: string;
  status: PaymentStatus;
  createdAt: string;
  confirmedAt: string | null;

  itemsAmount: number;
  addonsAmount: number;
  totalAmount: number;

  /** 支付成功生成的订单；未成功时为 null */
  orderId: string | null;

  snapshot: PaymentRequestSnapshot;
};

/** 支付成功的记录。本阶段只在成功时生成，因此状态固定为 success。 */
export type Payment = {
  id: string;
  paymentRequestId: string;
  orderId: string;
  userId: string;
  amount: number;
  status: "success";
  paidAt: string;
};

/** 创建支付请求后返回给客户端的最小信息。 */
export type PaymentRequestSummary = {
  id: string;
  status: PaymentStatus;
  totalAmount: number;
};

/** 模拟支付确认的结果。`duplicated` 为 true 表示这次确认没有产生新的订单（幂等命中）。 */
export type MockPaymentConfirmResult = {
  status: PaymentStatus;
  orderId: string | null;
  orderNo: string | null;
  duplicated: boolean;
};
