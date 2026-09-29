/**
 * 结算与支付类型。
 *
 * 贯穿始终的一条规则：**金额只由服务端计算**。
 * `CheckoutSelection`（用户选了什么）与金额严格分开，接口输入里根本没有价格字段可填。
 */
import type { Addon } from "./catalog";
import type { CheckoutCouponOption } from "./coupon";
import type { OrderAddonSnapshot, OrderCompanionSnapshot, OrderCouponSnapshot } from "./order";

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
  /**
   * 选填的优惠券**领取记录 id**（P1-4）。不用券时为 null。
   *
   * ⚠️ 传的是**领取记录 id**而不是券模板 id：用户手里的券是「哪一次领取」，
   * 同一张模板可能被同一个人领过（当前规则下不会，但类型上区分开更结实）。
   *
   * ⚠️ 这里只表达「用户选了哪张券」，**不含任何金额**：抵扣多少一律由服务端
   * 按券面快照算（与 `quantity`、`addonIds` 同一条纪律）。
   */
  couponClaimId: string | null;
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
  /**
   * 优惠前应付 = `itemsAmount + addonsAmount`。
   *
   * ⚠️ 字段名从「应付金额」改成了「优惠前应付」：接入券之后 `totalAmount` 不再是
   * 用户要付的钱，把它继续叫「应付金额」会让结算页底部那一行显示错数字
   * （用户要付的是 `actualPaidAmount`）。
   */
  originalAmount: number;
  /** 券实际抵扣（分）。没用券时为 0 */
  couponDiscountAmount: number;
  /** 用户实付 = `originalAmount − couponDiscountAmount`。**结算页底部显示的是它** */
  actualPaidAmount: number;
  /**
   * 用户选中的券（若有）。**判定结果一并返回**，因此界面不需要自己比门槛。
   *
   * ⚠️ 这里返回的是**判断**而不是**事实**：试算不消耗券，同一张券可以试算任意次。
   * 真正的核销发生在支付成功那一刻（裁定 §5）。
   *
   * `couponReason` 非空时券**没有生效**（`couponDiscountAmount` 为 0），
   * 界面必须**显示它并禁止支付**——放过去就等于让用户在以为有优惠的情况下付款。
   * 它同时覆盖两种情形：券取不到（`coupon` 为 null）与券取到了但不可用。
   */
  coupon: CheckoutCouponOption | null;
  /** 券未生效的原因；券已生效或压根没选时为 "" */
  couponReason: string;
  /**
   * 这个人**这一单**可选的券（P1-4）。
   *
   * 每一项的 `applicable` / `reason` / `discountAmount` 都已按**这一单的原价**
   * 判好，因此它必须跟着试算一起返回：单独做一个「我的优惠券」接口的话，
   * 列表里的门槛判定与当前这一单的金额可能来自两次不同的计算。
   */
  availableCoupons: CheckoutCouponOption[];
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
  /**
   * 游戏名快照。
   *
   * 与商品名一样在下单时固定下来，订单详情因此可以直接显示「哪个游戏」，
   * 不必在读取时回头查商品——商品改名或下架都不会影响历史订单。
   */
  gameName: string;
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

  /**
   * 券的实际抵扣额（分）。没用券时为 0。**创建支付请求时冻结**。
   *
   * ⚠️ 它必须冻结在这条记录上，理由与 `companionRateSnapshot` 完全一样：
   * 支付成功后的建单（`buildOrderFromRequest`）跑在支付仓储的**原子区段**里、
   * 是同步的，那里没有任何 `await` 可以回头去查券；而且建单用的券金额必须与
   * 用户在试算时看到的、以及他**即将支付的金额**完全一致。
   */
  couponDiscountAmount: number;
  /**
   * 用户实付 = `totalAmount − couponDiscountAmount`。**支付渠道收的钱**。
   *
   * ⚠️ 它也必须冻结：`Payment.amount` 与退款基数都读它，事后再算一次
   * 就意味着「渠道收了多少」有两个来源。
   */
  actualPaidAmount: number;
  /**
   * 这一单将要用掉的券快照（P1-4）。没用券时为 null。
   *
   * ⚠️ 它的**存在**是「用户选了这张券」，它的**状态**（`status`）不在这里——
   * 券此刻还没被核销，核销发生在支付成功的原子区段里（裁定 §5）。
   * 因此这条记录上的快照只是「建单时要复制到订单上的那份内容」，
   * 与 `snapshot`（商品 / 陪玩内容快照）是同一类东西。
   */
  coupon: OrderCouponSnapshot | null;

  /**
   * 商品的分账比例快照（基点，8000 = 80%），**创建支付请求时就冻结**（P0-3）。
   *
   * ⚠️ 它必须存在这条记录上，不能等到建单时再去取商品：支付成功后的建单
   * （`buildOrderFromRequest`）跑在支付仓储的**原子区段**里，是同步的，
   * 那里没有任何 `await` 可以取商品。冻结在这里还有第二个好处——
   * 用户看到的试算与最终分账用的是同一个比例，中途改商品不影响这一单。
   */
  companionRateSnapshot: number;

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
  /** 优惠前应付总额。⚠️ **不是**用户要付的钱 */
  totalAmount: number;
  /** 用户实付（P1-4）。**调用方要显示金额时用这个** */
  actualPaidAmount: number;
};

/** 模拟支付确认的结果。`duplicated` 为 true 表示这次确认没有产生新的订单（幂等命中）。 */
export type MockPaymentConfirmResult = {
  status: PaymentStatus;
  orderId: string | null;
  orderNo: string | null;
  duplicated: boolean;
};
