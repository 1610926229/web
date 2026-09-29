import { ApiError } from "@/lib/api/ApiError";
import { isCompanionAcceptingOrders } from "@/lib/constants/companions";
import {
  MAX_QUANTITY,
  REMARK_MAX_LENGTH,
  validateGameAccount,
} from "@/lib/constants/checkout";
import {
  COUPON_NOT_FOUND_MESSAGE,
  COUPON_USE_USED_REASON,
  resolveCouponApplication,
  toOrderCouponSnapshot,
} from "@/lib/constants/coupons";
import { resolveOrderMoneyDomain, type OrderMoneyDomain } from "@/lib/constants/orderAmount";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { createDispatchForOrder } from "@/lib/data/companionDispatchTransaction";
import { redeemCouponClaimForOrder } from "@/lib/data/couponRedemptionTransaction";
import { getCouponRepository } from "@/lib/data/couponRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getDataSource } from "@/lib/data/source";
import { loadCheckoutCoupons } from "@/lib/services/coupons";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Addon, Game } from "@/lib/types/catalog";
import type { Companion } from "@/lib/types/companion";
import type { CheckoutCouponOption } from "@/lib/types/coupon";
import type { Order, OrderCouponSnapshot } from "@/lib/types/order";
import type {
  CheckoutPreview,
  CheckoutSelection,
  MockPaymentResult,
  PaymentRequest,
  PaymentRequestSnapshot,
} from "@/lib/types/payment";
import type { ProductDetail, ProductSpec } from "@/lib/types/product";

/**
 * 结算与支付服务 —— 服务端与接口共用的唯一入口。
 *
 * 三条硬规则，本文件是它们唯一的落点：
 *
 * 1. **金额只由服务端算**。接口输入里只有「用户选了什么」（`CheckoutSelection`），
 *    没有任何价格字段；`parseSelectionInput` 按白名单取字段，客户端多塞的 price /
 *    totalAmount 之类会被直接丢弃。
 * 2. **下单时重新校验、重新计算**。正式创建支付请求时不会复用试算结果，
 *    而是把商品、规格、大区、增值服务、陪玩全部重新验证一遍并重算金额。
 * 3. **写入幂等**。幂等键与「成功只生成一次订单」由 `PaymentRepository` 保证，
 *    这里只负责把业务规则讲清楚，不依赖前端按钮禁用。
 *
 * 服务端页面（`/checkout`、`/pay/result`）直接调用本文件；浏览器经 `/api/orders/*`
 * 与 `/api/payments/*` 调用同一批函数。
 */

// ——————————————————————————— 只读目录 ———————————————————————————

export function getGame(id: string): Promise<Game | null> {
  return getDataSource().getGame(id);
}

export function getAddons(): Promise<Addon[]> {
  return getDataSource().listAddons();
}

export function getCompanions(): Promise<Companion[]> {
  return getDataSource().listCompanions();
}

// ——————————————————————————— 输入解析 ———————————————————————————

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 按**白名单**把请求体解析成业务选择。
 *
 * 只有下面这些字段会被读取，其余一律忽略——这是「客户端提交的金额不能影响订单价格」
 * 在代码层面的落点：不是「检查一下金额对不对」，而是根本不存在接收金额的字段。
 */
export function parseSelectionInput(body: Record<string, unknown>): CheckoutSelection {
  const rawAddonIds = body.addonIds;
  const addonIds = Array.isArray(rawAddonIds)
    ? rawAddonIds.filter((item): item is string => typeof item === "string")
    : [];

  return {
    productId: trimString(body.productId),
    specId: trimString(body.specId),
    quantity: Number(body.quantity),
    region: trimString(body.region),
    addonIds,
    gameAccountId: trimString(body.gameAccountId),
    remark: trimString(body.remark),
    companionId: trimString(body.companionId) || null,
    // 空串按「没用券」处理：界面上取消选择时发过来的就是这个
    couponClaimId: trimString(body.couponClaimId) || null,
  };
}

// ——————————————————————————— 输入校验 ———————————————————————————

function normalizeQuantity(value: unknown): number {
  const quantity = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(quantity)) {
    throw new ApiError("BAD_REQUEST", "购买数量无效");
  }
  if (quantity < 1) {
    throw new ApiError("BAD_REQUEST", "购买数量不能少于 1");
  }
  if (quantity > MAX_QUANTITY) {
    throw new ApiError("BAD_REQUEST", `单个订单最多购买 ${MAX_QUANTITY} 份`);
  }
  return quantity;
}

/** 增值服务：必须是目录内的项；重复项静默去重，避免重复计费。 */
async function resolveAddons(rawIds: string[]): Promise<Addon[]> {
  if (rawIds.length === 0) return [];

  const catalog = await getDataSource().listAddons();
  const seen = new Set<string>();
  const resolved: Addon[] = [];

  for (const raw of rawIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    const addon = catalog.find((item) => item.id === id);
    if (!addon) throw new ApiError("BAD_REQUEST", "增值服务无效，请重新选择");
    seen.add(id);
    resolved.push(addon);
  }
  return resolved;
}

/**
 * 陪玩：选填；填了就必须存在、**在公开名单里**且当前可选。
 *
 * 后两个条件现在由 `isCompanionAcceptingOrders()` **一个谓词**回答
 * （`= isCompanionListed() && available`，见 `lib/constants/companions.ts`）——
 * 之前这里是内联的等价写法，属于同一规则的第三份拷贝，已收敛回唯一真值源。
 *
 * 它同时挡住两类否定，方向不同（P8A）：
 * - `isCompanionListed()` 挡的是**停用与被移除**——这两类在用户端任何地方都不该出现，
 *   但 `getCompanion()` 取得到它们（后台要管理、直链详情要展示），
 *   所以「取得到」不等于「可以拿来下单」；
 * - `available` 挡的是**暂停接单**——仍在名单里、详情页正常可见，只是结算时不可选。
 *
 * 少了第一个判断，被移除的护航只要 id 还留在浏览器缓存里就能下单；
 * 少了第二个，「暂停接单」就只是列表上的一个字。
 */
async function resolveCompanion(id: string | null): Promise<Companion | null> {
  if (!id) return null;

  const companion = await getDataSource().getCompanion(id);
  if (!companion) throw new ApiError("BAD_REQUEST", "陪玩不存在，请重新选择");
  if (!isCompanionAcceptingOrders(companion)) {
    throw new ApiError("BAD_REQUEST", "该陪玩当前不可选，请重新选择");
  }
  return companion;
}

/**
 * 校验买家填写的内容：游戏 ID 必填，备注选填。**只在正式下单时校验**。
 *
 * 这一层不能省：前端的表单校验只是「提前告诉用户」，绕过页面直接调接口一样能提交。
 * 游戏 ID 与浏览器共用 `validateGameAccount`，两侧规则与提示文案完全一致。
 */
function validateBuyerInput(selection: CheckoutSelection): void {
  const account = validateGameAccount(selection.gameAccountId);
  if (!account.ok) {
    throw new ApiError("BAD_REQUEST", account.message);
  }
  if (selection.remark.length > REMARK_MAX_LENGTH) {
    throw new ApiError("BAD_REQUEST", `订单备注不能超过 ${REMARK_MAX_LENGTH} 个字`);
  }
}

/**
 * 校验商品、规格、数量、大区、增值服务、陪玩，并按服务端价格算出金额。
 *
 * 游戏 ID 与备注不在这里校验：价格试算发生在用户还没填完表单的时候，
 * 那时要求填完游戏 ID 只会让试算平白失败。它们的校验放在正式下单。
 */
async function resolveSelection(selection: CheckoutSelection): Promise<{
  selection: CheckoutSelection;
  product: ProductDetail;
  spec: ProductSpec;
  game: Game;
  addons: Addon[];
  companion: Companion | null;
  itemsAmount: number;
  addonsAmount: number;
  totalAmount: number;
  /** 商品此刻的分账比例（基点）。它随支付请求冻结，之后改商品不影响已下单的订单 */
  companionRateSnapshot: number;
}> {
  const source = getDataSource();

  if (!selection.productId) throw new ApiError("BAD_REQUEST", "缺少商品信息");

  const product = await source.getProductDetail(selection.productId);
  if (!product) throw new ApiError("NOT_FOUND", "商品不存在");
  if (product.status !== "on") throw new ApiError("BAD_REQUEST", "商品已下架，无法支付");

  const spec = product.specs.find((item) => item.id === selection.specId);
  if (!spec) throw new ApiError("BAD_REQUEST", "商品规格无效，请重新选择");

  const quantity = normalizeQuantity(selection.quantity);

  const game = await source.getGame(product.gameId);
  if (!game) throw new ApiError("SERVER_ERROR", "商品所属游戏数据异常");
  if (!selection.region) throw new ApiError("BAD_REQUEST", "请选择大区");
  if (!game.regions.includes(selection.region)) {
    throw new ApiError("BAD_REQUEST", "大区选择无效，请重新选择");
  }

  const addons = await resolveAddons(selection.addonIds);
  const companion = await resolveCompanion(selection.companionId);

  // —— 金额：全程「分」为单位的整数运算，不出现任何浮点数 ——
  const itemsAmount = spec.price * quantity;
  // 增值服务按单计费，不随数量变化
  const addonsAmount = addons.reduce((sum, addon) => sum + addon.price, 0);

  return {
    selection: { ...selection, quantity },
    product,
    spec,
    game,
    addons,
    companion,
    itemsAmount,
    addonsAmount,
    totalAmount: itemsAmount + addonsAmount,
    // 比例在**同一份商品读取**里拿到，与上面算钱用的价格同源
    companionRateSnapshot: product.companionRateBp,
  };
}

/**
 * 这一单的金额域：**下单那一刻**由商品与价格算出（P0-3）。
 *
 * 公式在 `lib/constants/orderAmount.ts`（`resolveOrderMoneyDomain`），本函数只把
 * 「下单这一刻」的输入凑齐。`couponDiscountAmount` 必须由调用方传进来，
 * **且已经过 `resolveCouponApplication()` 夹到不超过原价**——
 * 本函数不夹它（见 `OrderMoneyDomainInput.couponDiscountAmount` 的说明）。
 */
function resolveMoneyDomainForSelection(resolved: {
  itemsAmount: number;
  addonsAmount: number;
  companionRateBp: number;
  couponDiscountAmount: number;
}): OrderMoneyDomain {
  return resolveOrderMoneyDomain({
    itemsAmount: resolved.itemsAmount,
    addonsAmount: resolved.addonsAmount,
    companionRateBp: resolved.companionRateBp,
    // 金额只由服务端算：这里读的是**服务端自己判出来的**抵扣额，
    // 不是请求里带的任何数字（`CheckoutSelection` 里根本没有金额字段）
    couponDiscountAmount: resolved.couponDiscountAmount,
  });
}

// ——————————————————————————— 优惠券（P1-4） ———————————————————————————

/**
 * 「用户选的那张券在这一单上怎么样」的完整结论。
 *
 * 三个字段各回答一件事，缺任何一个都会让调用方被迫自己再判一次：
 *
 * | 字段 | 回答 |
 * |---|---|
 * | `applied` | 这一单**实际**要用掉的券（写进订单与支付请求的那份） |
 * | `option`  | 界面上要怎么**显示**这张券（含「不能用」的原因） |
 * | `reason`  | 选了但**连券都取不到**时的原因（此时没有 option 可显示） |
 *
 * `applied` 为 null 有两种含义，靠 `selection.couponClaimId` 区分：
 * 「没选券」与「选了但不可用」。调用方据此决定是放行还是拒绝。
 */
type CouponResolution = {
  applied: { snapshot: OrderCouponSnapshot; discountAmount: number } | null;
  option: CheckoutCouponOption | null;
  reason: string;
};

const NO_COUPON: CouponResolution = { applied: null, option: null, reason: "" };

/**
 * 解析用户选中的券（**只读**，不消耗任何东西）。
 *
 * 三条边界：
 *
 * 1. **判定只有一份实现**：门槛、有效期、形态、额度封顶全部走
 *    `resolveCouponApplication()`，试算与下单因此不可能给出不同结论。
 * 2. **不可用不在这里抛错**。试算需要把「为什么不能用」渲染给用户看，
 *    抛错会让它变成一整页失败。**是否拒绝由调用方决定**——
 *    `createPaymentRequest` 在拿到结论后抛 400（裁定 §2：不得静默按 0 元继续下单）。
 * 3. **不消耗**：核销在支付成功的原子区段里发生（裁定 §5），所以试算可以随便调。
 */
async function resolveCouponForSelection(
  selection: CheckoutSelection,
  /** 当前会话的用户。**不从 `selection` 里取**：那是客户端能改的东西 */
  userId: string,
  originalAmount: number,
  now: Date,
): Promise<CouponResolution> {
  if (!selection.couponClaimId) return NO_COUPON;

  const repository = getCouponRepository();
  // 按「用户 + 领取记录 id」查：**归属是查询条件的一部分**，别人的券在这里就查不到。
  // 不写成「先按 id 查出来、再比对 userId」——那种写法一旦有人漏掉那一步，
  // 就能拿别人的券下单
  const claim = await repository.findClaimById(userId, selection.couponClaimId);
  if (!claim) {
    return { applied: null, option: null, reason: COUPON_NOT_FOUND_MESSAGE };
  }

  // 券模板「此刻」是否启用。裁定未明文，本实现按「停用后已领取的也不能再用」处理
  const template = await repository.findCouponById(claim.couponId);
  const application = resolveCouponApplication(claim, originalAmount, now, template?.enabled ?? false);

  return {
    applied: application.applicable
      ? {
          snapshot: toOrderCouponSnapshot(claim),
          discountAmount: application.discountAmount,
        }
      : null,
    option: {
      claimId: claim.id,
      couponId: claim.couponId,
      name: claim.snapshot.name,
      valueLabel: claim.snapshot.valueLabel,
      conditionLabel: claim.snapshot.conditionLabel,
      validFrom: claim.snapshot.validFrom,
      validTo: claim.snapshot.validTo,
      applicable: application.applicable,
      reason: application.reason,
      discountAmount: application.discountAmount,
    },
    reason: "",
  };
}

/** 券不可用时的统一拒绝。金额风险相关的错误一律走这里，保证文案与状态码只有一份。 */
function rejectCoupon(reason: string): never {
  throw new ApiError("BAD_REQUEST", reason || COUPON_USE_USED_REASON);
}

// ——————————————————————————— 试算 ———————————————————————————

/**
 * 金额试算：只算钱，不落库、不产生任何记录。
 *
 * `surface` 用来支持 `?mockError=api`：只让浏览器端的试算失败，
 * 便于观察「试算失败 → 禁止支付 + 重试」这条路径，而不会把整页打挂。
 */
export function previewCheckout(
  selection: CheckoutSelection,
  /** 当前会话的用户。券有归属，试算也必须知道「这是谁的券」 */
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<CheckoutPreview> {
  return withMockDebug(params, surface, async () => {
    const resolved = await resolveSelection(selection);

    // 门槛基数是**优惠前应付**（裁定 §2），因此这里先算出原价再判券。
    // 试算是只读的：判定结果原样返回给界面，不抛错、也不消耗券
    const originalAmount = resolved.itemsAmount + resolved.addonsAmount;
    const coupon = await resolveCouponForSelection(selection, userId, originalAmount, new Date());

    // 抵扣只在**券可用**时生效；券不可用时试算仍然返回正常金额（原价 = 实付），
    // 同时把 `coupon.reason` 一并交给界面去显示与阻断支付
    const couponDiscountAmount = coupon.applied?.discountAmount ?? 0;

    return {
      product: {
        id: resolved.product.id,
        title: resolved.product.title,
        subtitle: resolved.product.subtitle,
        coverUrl: resolved.product.coverUrl,
      },
      spec: { id: resolved.spec.id, name: resolved.spec.name, price: resolved.spec.price },
      quantity: resolved.selection.quantity,
      addons: resolved.addons,
      itemsAmount: resolved.itemsAmount,
      addonsAmount: resolved.addonsAmount,
      originalAmount,
      couponDiscountAmount,
      actualPaidAmount: originalAmount - couponDiscountAmount,
      coupon: coupon.option,
      // **单一**的「这一单为什么用不上这张券」，两种来源合成一句：
      // 券取不到（`coupon.reason`）或券取到了但不能用（`option.reason`）。
      // 界面只需要判这一个字段就能决定「显示原因 + 禁止支付」，
      // 不必自己拼两种情形——那正是两侧口径开始分叉的地方
      couponReason: coupon.applied ? "" : (coupon.reason || coupon.option?.reason || ""),
      // 可选的券**跟着这一单的原价一起算**，因此它永远不会过期：
      // 用户改数量、加增值服务，金额变了，下一次试算里每一张券的
      // 「能用 / 未达门槛」就是按新金额判的。
      // ⚠️ 这正是它必须挂在试算上、而不是单独做一个「我的券」接口的原因：
      // 分开取就意味着两边的原价可能不是同一个，而门槛判定完全依赖它
      availableCoupons: await loadCheckoutCoupons(userId, originalAmount),
    };
  });
}

// ——————————————————————————— 创建支付请求 ———————————————————————————

/** 展示用订单号：日期 + 随机尾号。只用于展示，不作为任何业务主键。 */
function makeOrderNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const tail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `YM${stamp}${tail}`;
}

/**
 * 由支付请求生成订单 —— **并且在这里同时建立派单记录**（P0-5）。
 *
 * ⚠️ 本函数跑在支付仓储的**原子区段**里（`confirmPaymentRequest` 的 `buildOrder` 回调），
 * 因此它里面不能有任何 `await`：金额只能从支付请求上冻结的那份数据算，
 * 派单也必须用**同步**的 `createDispatchForOrder()` 建立。
 *
 * ⚠️ **订单与派单必须同时诞生**。分成两步（先建订单、再建派单）会留下一个真实的窗口：
 * 那一刻的订单既没有截止时间、也不会被任何池子看到、更不会超时退款——
 * 一旦第二步失败，这张单就永远卡在「已付款、没人能接」。
 *
 * ⚠️ 订单创建时**不带打手**：`actualCompanionId` 与 `companion` 都是 null。
 * 用户在结算页选的那位进的是 `Dispatch.exclusiveCompanionId`——「用户指定的人」
 * 与「实际接单的人」是两个事实，订单上只写后者，而此刻还没有人接。
 */
function buildOrderFromRequest(request: PaymentRequest): Order {
  const now = new Date();
  const at = now.toISOString();

  // —— 金额域先算，因为它**纯**且**可能失败** ——
  // 它在这里从支付请求上冻结的那份数据算出来：本函数跑在支付仓储的原子区段里，
  // 只能读请求上已有的字段（含下单那一刻冻住的分账比例），不能去取商品。
  //
  // ⚠️ 顺序有意为之：纯计算排在核销之前。金额只由冻结的输入决定，
  // 因此它要么算得出来、要么这一单本来就不该成交；把它放在核销**后面**的话，
  // 一旦它抛错，券已经被标成 `used` 而没有订单——正好是裁定 §5 禁止的
  // 「支付失败却把券永久标记 used」。
  const money = resolveMoneyDomainForSelection({
    itemsAmount: request.itemsAmount,
    addonsAmount: request.addonsAmount,
    // 支付请求上冻住的比例就是这一单的比例（建单时不再看商品）
    companionRateBp: request.companionRateSnapshot,
    // 抵扣额同样是冻在请求上的那份。它与创建请求时算出来的**必然相等**：
    // 输入（商品金额、增值服务、券面快照）全部已冻结，公式又是同一处
    couponDiscountAmount: request.couponDiscountAmount,
  });

  // —— 核销（裁定 §5）：唯一的核销点，也是**最后一道**券可用性闸门 ——
  //
  // - 放在**原子区段内**，是为了堵住双花：用户对同一张券建两笔待支付请求
  //   （换个幂等键即可），第 2 笔在这里会看到券已经是 `used`，于是抛错、不建单。
  //   区段内没有 `await`，因此两次确认不可能交错看到「都还是 unused」；
  // - 排在 `createDispatchForOrder()` **之前**，是因为那一步会写下派单记录。
  //   若在它之后再发现券不可用，派单已经写下去了，抛错留下的是
  //   「有派单、没有订单」的半成品。上面那道纯计算闸门已经先行排掉了这一批失败。
  //
  // 失败一律抛错（而不是建一张没有券的订单）：金额在产品看来已经是「减完的」，
  // 悄悄按原价成交就是裁定 §2 禁止的那种静默降级。
  //
  // ⚠️ **残留窗口（如实记录，不假装已关闭）**：核销成功之后、订单写下去之前，
  // 只剩下 `createDispatchForOrder()` 与几行 Map 写入。
  //
  // ⚠️ 准确地说：在**当前的 mock 实现**里，这一小段没有已知的抛错点——
  // Map 写入不会抛，`crypto.randomUUID()` / `plusMinutes(at, 正整数)` 不会抛，
  // 而派单路径上的 `normalizePlatformConfig()`（`mockPlatformConfigRepository.ts`）
  // 是**兜底不抛**的：非法 / 缺失字段一律回退默认值，`{...undefined}` / `{...null}` 也不抛。
  //
  // 但这**不能**升级成「窗口已关闭」。关不严是**架构性质**的：订单与券核销记录
  // 在两个不同的 Mock 存储上，没有跨存储事务可依，因此「核销已落、订单未落」这个
  // 中间态在原理上可达；上面那句「当前没有已知抛错点」修饰的是**今天的实现**，
  // 不是一条不变量——将来任何一处引入异步（换真仓储、加一次 `await`）它就会失效。
  // 这个窗口**先于 P1-4 存在**（派单本来就在建单之前写），P1-4 只是把它收窄到最小。
  if (request.coupon) {
    const redemption = redeemCouponClaimForOrder({
      userId: request.userId,
      claimId: request.coupon.claimId,
      // 门槛基数是**优惠前应付**（裁定 §2）
      originalAmount: request.totalAmount,
      at,
    });
    if (!redemption.ok) rejectCoupon(redemption.reason);
  }

  const order: Order = {
    id: `ord_${crypto.randomUUID()}`,
    orderNo: makeOrderNo(now),
    userId: request.userId,
    status: "paid",
    createdAt: at,
    paidAt: at,
    // 新订单只有「已付款」一个时间节点，其余状态由后续阶段推进时写入
    acceptedAt: null,
    // 刚建出来当然还没被任何人承接。此后**只有** `applyOrderAccepted()` 会写它，
    // 而且写上之后任何路径都不清空（P1-4 验收整改轮 §一）
    everAcceptedAt: null,
    servingAt: null,
    completedAt: null,
    refundedAt: null,

    productId: request.productId,
    productTitle: request.snapshot.productTitle,
    productCoverUrl: request.snapshot.productCoverUrl,
    specId: request.specId,
    specName: request.snapshot.specName,
    unitPrice: request.snapshot.unitPrice,

    quantity: request.quantity,
    gameName: request.snapshot.gameName,
    region: request.region,
    gameAccountId: request.gameAccountId,
    remark: request.remark,
    addons: request.snapshot.addons,

    itemsAmount: request.itemsAmount,
    addonsAmount: request.addonsAmount,
    totalAmount: request.totalAmount,

    // —— 金额域（P0-3）：由支付请求上冻结的金额与比例算出 ——
    ...money,
    // 刚创建的订单一笔都没退过。累计已退由退款的写入路径维护（P1 接入退款金额公式）
    refundedAmount: 0,

    // 券快照原样落到订单上（裁定 §9）。⚠️ 退款**不**清空它（裁定 §6）：
    // 它记录的是「这一单当初用了哪张券」，退款改变不了这个历史事实
    coupon: request.coupon,

    // 还没有人接单。用户在下单时选的那位写在下面的派单记录里，不写在这里
    actualCompanionId: null,
    companion: null,

    // —— 投诉窗口快照（P0-9）——
    // 下单时**不冻结**：这一刻既没有 completed，也还不知道会不会有投诉窗口这回事
    // （订单可能被退款、可能进了 completed 之后才谈得上窗口）。两者由
    // `applyOrderCompletion` 在订单真正进入 completed 的同一段同步代码里一起写。
    complaintWindowMinutesSnapshot: null,
    complaintDeadlineAt: null,
  };

  // 与订单同一段、无 `await`：订单存在的那一刻，派单记录就必须已经存在
  createDispatchForOrder({
    orderId: order.id,
    // 结算页选了人 → 专属池；没选 → 直接进公共池
    exclusiveCompanionId: request.snapshot.companion ? request.snapshot.companion.id : null,
    at,
  });

  return order;
}

/**
 * 创建支付请求。
 *
 * **不生成订单**——订单只在支付成功后生成。这里做的是：重新完整校验并重算金额
 * （不复用任何一次 preview 的结果），然后把这一次的「选择 + 金额 + 内容快照」固定下来。
 *
 * 幂等：同「用户 + 幂等键」只会有一条支付请求，重复提交返回第一次创建的那条。
 * 检查与写入由仓库在同一段同步代码里完成，因此快速连点或网络重试都不会多出记录。
 */
export async function createPaymentRequest(
  rawInput: Record<string, unknown>,
  userId: string,
): Promise<{ request: PaymentRequest; created: boolean }> {
  // 幂等键的格式与提示文案由 `lib/constants/writes.ts` 统一提供（退款与投诉用的是同一套）
  const idempotencyKey = readIdempotencyKey(rawInput);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const repository = getPaymentRepository();

  // 快速路径：这个键已经提交过，直接返回第一次的结果，连校验都不必重来——
  // 重试要的就是「和上次完全一样的结果」，而不是「按现在的状态重新算一遍」。
  const existing = await repository.findPaymentRequestByKey(userId, idempotencyKey);
  if (existing) return { request: existing, created: false };

  const selection = parseSelectionInput(rawInput);
  // 正式下单要校验全部内容，包括游戏 ID 与备注
  validateBuyerInput(selection);
  const resolved = await resolveSelection(selection);

  const now = new Date();
  const at = now.toISOString();

  // —— 券：判定与试算共用同一份实现，但**失败表现不同** ——
  // 试算把原因交给界面去显示；下单则**明确拒绝**（裁定 §2：不得静默改成 0 元优惠继续下单）。
  // 两者的结论因此不可能分叉：同一个 `resolveCouponApplication()`。
  const originalAmount = resolved.totalAmount;
  const coupon = await resolveCouponForSelection(selection, userId, originalAmount, now);
  if (selection.couponClaimId && !coupon.applied) {
    rejectCoupon(coupon.reason || coupon.option?.reason || COUPON_NOT_FOUND_MESSAGE);
  }

  // 金额域在这里算**一次**并冻结进支付请求：实付、抵扣额、分账比例都在这一刻定下来。
  // 建单时会用这些冻结值重算一遍，两者必然相等（输入已冻结、公式只有一处）
  const money = resolveMoneyDomainForSelection({
    itemsAmount: resolved.itemsAmount,
    addonsAmount: resolved.addonsAmount,
    companionRateBp: resolved.companionRateSnapshot,
    couponDiscountAmount: coupon.applied?.discountAmount ?? 0,
  });

  const snapshot: PaymentRequestSnapshot = {
    productTitle: resolved.product.title,
    productCoverUrl: resolved.product.coverUrl,
    specName: resolved.spec.name,
    unitPrice: resolved.spec.price,
    gameName: resolved.game.name,
    addons: resolved.addons.map((addon) => ({
      id: addon.id,
      name: addon.name,
      price: addon.price,
    })),
    companion: resolved.companion
      ? {
          id: resolved.companion.id,
          // 快照字段名保持 `name`（订单与评价的历史展示都按它读），
          // 值取陪玩唯一的昵称字段 `displayName`：订单快照是**那一刻的抄本**，
          // 含义不变，只是源头改了名字
          name: resolved.companion.displayName,
          avatarUrl: resolved.companion.avatarUrl,
        }
      : null,
  };

  return repository.createPaymentRequest({
    id: `pr_${crypto.randomUUID()}`,
    userId,
    idempotencyKey,
    status: "pending",
    createdAt: at,
    confirmedAt: null,

    productId: resolved.product.id,
    specId: resolved.spec.id,
    quantity: resolved.selection.quantity,
    region: resolved.selection.region,
    addonIds: resolved.addons.map((addon) => addon.id),
    gameAccountId: resolved.selection.gameAccountId,
    remark: resolved.selection.remark,
    companionId: resolved.companion ? resolved.companion.id : null,
    couponClaimId: selection.couponClaimId,

    itemsAmount: resolved.itemsAmount,
    addonsAmount: resolved.addonsAmount,
    totalAmount: resolved.totalAmount,

    // 券的抵扣额与**实付**同样在这一刻冻结。它们是「渠道收多少钱」的唯一来源，
    // 而支付成功后的建单跑在原子区段里、没有 `await` 可以回头再问一次券
    couponDiscountAmount: money.couponDiscountAmount,
    actualPaidAmount: money.actualPaidAmount,
    // 快照的**内容**在这时抄好，但券此刻还没被核销——核销在支付成功那一刻发生
    coupon: coupon.applied?.snapshot ?? null,

    // 分账比例在这一刻冻结进支付请求：此后商品改比例，这一单不受影响（幂等重放也一样）
    companionRateSnapshot: resolved.companionRateSnapshot,

    orderId: null,
    snapshot,
  });
}

// ——————————————————————————— 确认支付 ———————————————————————————

export type PaymentRequestLookup =
  | { ok: true; request: PaymentRequest }
  | { ok: false; reason: "not_found" | "forbidden" };

/**
 * 读取一条支付请求，并校验它属于当前用户。
 *
 * 页面因此可以区分「不存在」与「不属于你」；而给浏览器的接口对两者一律返回 404，
 * 避免用接口去枚举别人的支付请求 id。
 */
export async function getPaymentRequestForUser(
  requestId: string,
  userId: string,
): Promise<PaymentRequestLookup> {
  if (!requestId) return { ok: false, reason: "not_found" };

  const request = await getPaymentRepository().findPaymentRequestById(requestId);
  if (!request) return { ok: false, reason: "not_found" };
  if (request.userId !== userId) return { ok: false, reason: "forbidden" };
  return { ok: true, request };
}

/**
 * 确认支付结果（模拟渠道）。
 *
 * 成功：标记支付请求为成功，并**只生成一次**订单与支付记录，返回订单。
 * 失败 / 取消：只改状态，不生成订单，也不会出现在用户订单列表里。
 * 重复确认：返回既有结果，`orderCreated` 为 false —— 幂等由仓库保证。
 */
export async function confirmPaymentRequest(
  requestId: string,
  result: MockPaymentResult,
  userId: string,
): Promise<
  | { ok: true; request: PaymentRequest; order: Order | null; orderCreated: boolean }
  | { ok: false; reason: "not_found" | "forbidden" }
> {
  const lookup = await getPaymentRequestForUser(requestId, userId);
  if (!lookup.ok) return lookup;

  const settled = await getPaymentRepository().confirmPaymentRequest(
    requestId,
    result,
    buildOrderFromRequest,
  );
  if (!settled) return { ok: false, reason: "not_found" };

  return { ok: true, ...settled };
}

/** 支付成功后读取订单（用于结果页展示订单号）。仅限订单所有者。 */
export async function getOrderForUser(orderId: string, userId: string): Promise<Order | null> {
  const order = await getPaymentRepository().findOrderById(orderId);
  if (!order || order.userId !== userId) return null;
  return order;
}
