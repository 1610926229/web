import { ApiError } from "@/lib/api/ApiError";
import { isCompanionListed } from "@/lib/constants/companions";
import {
  MAX_QUANTITY,
  REMARK_MAX_LENGTH,
  validateGameAccount,
} from "@/lib/constants/checkout";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getDataSource } from "@/lib/data/source";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Addon, Game } from "@/lib/types/catalog";
import type { Companion } from "@/lib/types/companion";
import type { Order } from "@/lib/types/order";
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
 * 两个条件都要查，而且方向不同（P8A）：
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
  if (!isCompanionListed(companion) || !companion.available) {
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
  };
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
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<CheckoutPreview> {
  return withMockDebug(params, surface, async () => {
    const resolved = await resolveSelection(selection);
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
      totalAmount: resolved.totalAmount,
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

function buildOrderFromRequest(request: PaymentRequest): Order {
  const now = new Date();
  return {
    id: `ord_${crypto.randomUUID()}`,
    orderNo: makeOrderNo(now),
    userId: request.userId,
    status: "paid",
    createdAt: now.toISOString(),
    paidAt: now.toISOString(),
    // 新订单只有「已付款」一个时间节点，其余状态由后续阶段推进时写入
    acceptedAt: null,
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

    companionId: request.snapshot.companion ? request.snapshot.companion.id : null,
    companion: request.snapshot.companion,
  };
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

  const now = new Date().toISOString();
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
    createdAt: now,
    confirmedAt: null,

    productId: resolved.product.id,
    specId: resolved.spec.id,
    quantity: resolved.selection.quantity,
    region: resolved.selection.region,
    addonIds: resolved.addons.map((addon) => addon.id),
    gameAccountId: resolved.selection.gameAccountId,
    remark: resolved.selection.remark,
    companionId: resolved.companion ? resolved.companion.id : null,

    itemsAmount: resolved.itemsAmount,
    addonsAmount: resolved.addonsAmount,
    totalAmount: resolved.totalAmount,

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
