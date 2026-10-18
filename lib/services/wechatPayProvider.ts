/**
 * 真实微信支付 provider 的**预留接口**（本轮不启用）。
 *
 * ## 本轮只定义形状，不实现任何真实支付
 *
 * 本项目当前只有模拟支付（`ENABLE_MOCK_PAYMENT` + `/api/payments/mock-confirm`）。
 * 真实微信支付需要商户号、APIv3 密钥、商户证书、回调域名与验签，且涉及真实资金。
 * 在这些资质与专门的安全验收完成前，本文件：
 *
 * - **不读取**任何商户环境变量；
 * - **不发送**任何真实网络请求；
 * - **不提供**任何路由；
 * - 所有方法都抛 `WechatPayNotConfiguredError`。
 *
 * 保留接口的原因是让订单系统将来接入支付渠道时有明确边界：
 * 统一下单、查询、关单、退款、回调验签、回调幂等、对账 —— 一个都不能少，
 * 而且都必须是服务端实现。**不允许**用「客户端回传 paid=true」代替其中任何一步。
 *
 * ## 接入真实支付前必须补齐的安全项
 *
 * 1. APIv3 密钥与商户私钥只存在受保护的服务端配置中，不进入 Git / 日志 / 前端；
 * 2. 回调必须验签（平台证书/公钥），验签失败一律拒绝；
 * 3. 回调幂等以微信支付单号 + 业务单号为准，重复通知返回成功但不重复记账；
 * 4. 金额以服务端订单为准，与微信返回的金额逐笔比对；
 * 5. 关单/退款/对账都有审计与失败补偿；
 * 6. 真实支付开关默认关闭，只有显式开启且通过安全验收后才可调用。
 */

export type WechatPayCreateOrderInput = {
  /** 平台订单号（out_trade_no），必须唯一 */
  outTradeNo: string;
  /** 服务端重算后的应付金额，单位分 */
  amountFen: number;
  description: string;
  /** 支付结果回调地址（必须是已备案 HTTPS 域名） */
  notifyUrl: string;
};

export type WechatPayOrderState =
  | "not-exist"
  | "pending"
  | "paid"
  | "closed"
  | "refunded";

export type WechatPayQueryResult = {
  outTradeNo: string;
  state: WechatPayOrderState;
  /** 微信支付单号（transaction_id）；未支付时为空 */
  transactionId: string | null;
  amountFen: number | null;
};

export type WechatPayNotification = {
  eventId: string;
  outTradeNo: string;
  transactionId: string;
  amountFen: number;
  paidAt: string;
};

export type WechatPayRefundInput = {
  outTradeNo: string;
  outRefundNo: string;
  refundFen: number;
  reason: string;
};

export type WechatPayRefundResult = {
  outRefundNo: string;
  state: "processing" | "success" | "failed";
  refundId: string | null;
};

export type WechatPayReconcileResult = {
  day: string;
  totalOrders: number;
  matchedOrders: number;
  mismatchedOutTradeNos: string[];
};

export interface WechatPayProvider {
  createUnifiedOrder(input: WechatPayCreateOrderInput): Promise<{ prepayId: string }>;
  queryOrder(outTradeNo: string): Promise<WechatPayQueryResult>;
  closeOrder(outTradeNo: string): Promise<void>;
  refund(input: WechatPayRefundInput): Promise<WechatPayRefundResult>;
  /** 验证回调签名并解析。验签失败必须抛错，不得返回「未知但放行」。 */
  verifyNotification(headers: Headers, rawBody: string): Promise<WechatPayNotification>;
  /** 处理已验签的回调；重复通知返回 duplicate，不重复记账。 */
  handleNotification(
    notification: WechatPayNotification,
  ): Promise<{ duplicate: boolean }>;
  reconcile(day: string): Promise<WechatPayReconcileResult>;
}

export class WechatPayNotConfiguredError extends Error {
  constructor() {
    super("真实微信支付尚未配置，本轮不启用真实资金交易。");
    this.name = "WechatPayNotConfiguredError";
  }
}

const NOT_IMPLEMENTED = (): never => {
  throw new WechatPayNotConfiguredError();
};

/**
 * 当前环境唯一可用的「真实支付 provider」：一个所有方法都拒绝的桩。
 *
 * 它存在的意义是**证明真实支付没有被偷偷打开**：任何调用都会立刻抛错，
 * 不会创建交易，也不会返回一个看起来成功的对象。
 */
export const disabledWechatPayProvider: WechatPayProvider = {
  createUnifiedOrder: async () => NOT_IMPLEMENTED(),
  queryOrder: async () => NOT_IMPLEMENTED(),
  closeOrder: async () => NOT_IMPLEMENTED(),
  refund: async () => NOT_IMPLEMENTED(),
  verifyNotification: async () => NOT_IMPLEMENTED(),
  handleNotification: async () => NOT_IMPLEMENTED(),
  reconcile: async () => NOT_IMPLEMENTED(),
};

/** 真实微信支付开关。**当前恒为 false**，直到商户资质与安全验收完成。 */
export function isRealWechatPayEnabled(): boolean {
  return false;
}
