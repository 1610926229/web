import type { PageResult } from "@/lib/types/common";
import type { Order, OrderCouponSnapshot, OrderStatus } from "@/lib/types/order";
import type {
  MockPaymentResult,
  Payment,
  PaymentRequest,
  PaymentRequestSnapshot,
  PaymentStatus,
} from "@/lib/types/payment";
import type { AdminOrderQueryFilter, PaymentRepository } from "../paymentRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
// ⚠️ `orders` 的列清单与行 → 领域对象映射从 `w1Rows.ts` 取，**不在这里再写一份**。
// 本轮有 6 个 Pg 事务与 13 个 Pg 仓储在读这张表；各写一份的话，漏掉一个列不会报错，
// 只会让某个页面悄悄少显示一个字段。（原实现是本文件私有的，已合并回唯一真值源。）
import { ORDER_COLUMNS, toOrder, type OrderRow } from "./w1Rows";

/**
 * `PaymentRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/paymentRepository.ts` 里的接口一个字没改，
 * 上层服务层、路由、页面都不知道底下换了一个存储。订单之所以和支付请求 / 支付记录
 * 在同一个仓储里，理由见接口文件头——支付成功生成的订单与预置订单必须是同一批数据。
 *
 * ## 与 Mock 的差异只有两处，都是**结构**而不是规则
 *
 * 1. **幂等靠唯一索引，不靠「先读后写」**。Mock 的 `createPaymentRequest` 是
 *    `Map` 里查一次、没有再 `set`；换成数据库后同样的写法会在两个并发请求之间出现空档
 *    （先 `SELECT` 判断、没有再 `INSERT`，两边都查到「没有」就都写）。这里改成
 *    `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING` + 冲突后回读，
 *    判重职责从应用层搬到 `UNIQUE (user_id, idempotency_key)` 上。
 * 2. **确认支付用条件 `UPDATE` 认领，而不是读写两个 `Map`**。`confirmPaymentRequest`
 *    的 `UPDATE … WHERE id = $1 AND status = 'pending'` 就是 Mock 里那段无 `await` 的
 *    「检查是不是 pending、然后置终态」——并发下只有一个请求能改到行，后到的会等到锁
 *    释放后重新求值 `WHERE`，发现已经不是 `pending`，于是改 0 行，走「重复确认」分支。
 *    这样「一个支付请求至多生成一个订单」在数据库层是结构性的（`payment_requests.order_id`
 *    上的 `UNIQUE` 是第二道保险）。
 *
 * ## ⚠️ 关于原子性：写方法必须跑在调用方的事务里
 *
 * 这个工厂和 `favoriteRepository.ts` 一样，**同时产出两种仓储**：
 *
 * - 传进程级执行器 → 每条语句自动提交；
 * - 传 `withTransaction` 给出的 `TxHandle` → 事务内仓储，与同一事务里的其它写入共享
 *   同一个提交点。
 *
 * `createPaymentRequest` / `confirmPaymentRequest` 在 Mock 里是一段**无 `await` 的原子区段**
 * （「标记支付请求 + 生成订单 + 生成支付记录」必须一次完成）。换成数据库后，这段原子性
 * 只能由**数据库事务**提供，而本工厂只拿到一个 `PgQueryable`。因此：
 *
 * > 需要原子性的调用方必须把本工厂建在 `withTransaction` 的 `TxHandle` 上，而不是进程级执行器。
 *
 * 仓储本身只负责「恰好写一次、判重靠索引」，事务边界是调用方的事——这正是
 * `executor.ts` 设计两种执行环境的理由。
 *
 * ## 时间与 JSON
 *
 * `created_at` / `paid_at` / … 都是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成
 * ISO 字符串（或 null），因此领域对象里仍是 `string`，Mock 里那套字典序比较原样成立。
 * `addons` / `coupon` / `snapshot` 是 `jsonb`，驱动直接解析成 JS 值。
 */

type PaymentRequestRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  status: string;
  product_id: string;
  spec_id: string;
  quantity: number;
  region: string;
  addon_ids: unknown;
  game_account_id: string;
  remark: string;
  companion_id: string | null;
  coupon_claim_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  items_amount: number;
  addons_amount: number;
  total_amount: number;
  coupon_discount_amount: number;
  actual_paid_amount: number;
  companion_rate_snapshot: number;
  coupon: unknown;
  snapshot: unknown;
  order_id: string | null;
};

type PaymentRow = {
  id: string;
  payment_request_id: string;
  order_id: string;
  user_id: string;
  amount: number;
  status: string;
  paid_at: string;
};

/** 显式列出**全部**列，不用 `SELECT *`：列一旦是通配的，往表里加一列就会悄无声息地
 * 顺着查询流进领域对象；显式列出则逼着每一次表结构变更都改到这里。
 * （`orders` 的那一份在 `w1Rows.ts`。） */
const PAYMENT_REQUEST_COLUMNS =
  "id, user_id, idempotency_key, status, product_id, spec_id, quantity, region, addon_ids, " +
  "game_account_id, remark, companion_id, coupon_claim_id, created_at, confirmed_at, items_amount, " +
  "addons_amount, total_amount, coupon_discount_amount, actual_paid_amount, companion_rate_snapshot, " +
  "coupon, snapshot, order_id";

const PAYMENT_COLUMNS = "id, payment_request_id, order_id, user_id, amount, status, paid_at";

/** 生成 `$1, $2, …`，供 INSERT 的 VALUES 与占位符数量对齐。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");
}

function toPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  return {
    id: row.id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as PaymentStatus,
    productId: row.product_id,
    specId: row.spec_id,
    quantity: row.quantity,
    region: row.region,
    addonIds: Array.isArray(row.addon_ids) ? (row.addon_ids as string[]) : [],
    gameAccountId: row.game_account_id,
    remark: row.remark,
    companionId: row.companion_id,
    couponClaimId: row.coupon_claim_id,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    itemsAmount: row.items_amount,
    addonsAmount: row.addons_amount,
    totalAmount: row.total_amount,
    couponDiscountAmount: row.coupon_discount_amount,
    actualPaidAmount: row.actual_paid_amount,
    companionRateSnapshot: row.companion_rate_snapshot,
    coupon: (row.coupon ?? null) as OrderCouponSnapshot | null,
    orderId: row.order_id,
    snapshot: row.snapshot as PaymentRequestSnapshot,
  };
}

/** `PaymentRequest` 各列的值，顺序与 `PAYMENT_REQUEST_COLUMNS` 严格一致。 */
function paymentRequestValues(request: PaymentRequest): unknown[] {
  return [
    request.id,
    request.userId,
    request.idempotencyKey,
    request.status,
    request.productId,
    request.specId,
    request.quantity,
    request.region,
    JSON.stringify(request.addonIds),
    request.gameAccountId,
    request.remark,
    request.companionId,
    request.couponClaimId,
    request.createdAt,
    request.confirmedAt,
    request.itemsAmount,
    request.addonsAmount,
    request.totalAmount,
    request.couponDiscountAmount,
    request.actualPaidAmount,
    request.companionRateSnapshot,
    request.coupon ? JSON.stringify(request.coupon) : null,
    JSON.stringify(request.snapshot),
    request.orderId,
  ];
}

/** `Order` 各列的值，顺序与 `ORDER_COLUMNS` 严格一致。 */
function orderValues(order: Order): unknown[] {
  return [
    order.id,
    order.orderNo,
    order.userId,
    order.status,
    order.createdAt,
    order.paidAt,
    order.acceptedAt,
    order.servingAt,
    order.completedAt,
    order.refundedAt,
    order.everAcceptedAt,
    order.productId,
    order.productTitle,
    order.productCoverUrl,
    order.specId,
    order.specName,
    order.unitPrice,
    order.quantity,
    order.gameName,
    order.region,
    order.gameAccountId,
    order.remark,
    JSON.stringify(order.addons),
    order.itemsAmount,
    order.addonsAmount,
    order.totalAmount,
    order.originalAmount,
    order.couponDiscountAmount,
    order.actualPaidAmount,
    order.companionRateSnapshot,
    order.companionBaseIncome,
    order.clubNetIncome,
    order.refundedAmount,
    order.coupon ? JSON.stringify(order.coupon) : null,
    order.actualCompanionId,
    order.companion ? JSON.stringify(order.companion) : null,
    order.complaintWindowMinutesSnapshot,
    order.complaintDeadlineAt,
  ];
}

function paymentValues(payment: Payment): unknown[] {
  return [
    payment.id,
    payment.paymentRequestId,
    payment.orderId,
    payment.userId,
    payment.amount,
    payment.status,
    payment.paidAt,
  ];
}

/** 与 `mockPaymentRepository.ts` 的 `RESULT_TO_STATUS` 一字不差。 */
const RESULT_TO_STATUS: Record<MockPaymentResult, PaymentStatus> = {
  success: "success",
  failure: "failed",
  cancel: "cancelled",
};

/**
 * 用任意可执行 SQL 的对象造一个订单 / 支付仓储。
 *
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让「确认支付」与同一事务里的其它写入
 * 共享同一个提交点；传进程级执行器则每条语句自动提交。
 */
export function createPaymentRepository(db: PgQueryable): PaymentRepository {
  async function findPaymentRequestByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<PaymentRequest | null> {
    // `(user_id, idempotency_key)` 就是 C2 的幂等键落点：这一句是它的唯一查询入口
    const rows = await db.query<PaymentRequestRow>(
      `SELECT ${PAYMENT_REQUEST_COLUMNS} FROM payment_requests
        WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return rows[0] ? toPaymentRequest(rows[0]) : null;
  }

  async function findPaymentRequestById(id: string): Promise<PaymentRequest | null> {
    const rows = await db.query<PaymentRequestRow>(
      `SELECT ${PAYMENT_REQUEST_COLUMNS} FROM payment_requests WHERE id = $1`,
      [id],
    );
    return rows[0] ? toPaymentRequest(rows[0]) : null;
  }

  async function findOrderById(id: string): Promise<Order | null> {
    const rows = await db.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [id],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  /**
   * 写一条订单。冲突（同一 id 已存在）时**不覆盖**，回读既有那一行。
   *
   * 正常路径上「确认支付」的条件 `UPDATE` 已经保证只有一个请求能走到这里，
   * 因此冲突只可能来自「同一 id 被写了两次」这种编程错误。宁可回读既有事实，
   * 也不能把它顶掉——一条已存在的订单是业务事实。
   */
  async function insertOrder(order: Order): Promise<void> {
    const values = orderValues(order);

    // 最多两轮：第二轮只在「冲突命中后、回读之前，那行被并发删掉」时才会发生
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await db.query<OrderRow>(
        `INSERT INTO orders (${ORDER_COLUMNS})
         VALUES (${placeholders(values.length)})
         ON CONFLICT (id) DO NOTHING
         RETURNING ${ORDER_COLUMNS}`,
        values,
      );
      if (inserted[0]) return;

      const existing = await findOrderById(order.id);
      if (existing) return;
      // 既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
    }

    throw new Error(`订单写入在并发下未能收敛（订单 ${order.id}）。`);
  }

  /**
   * 写一条支付记录。一次支付确认只产生一条，因此冲突目标是 `UNIQUE (payment_request_id)`
   * （`UNIQUE (order_id)` 是同一件事的第二个引用）。冲突时回读既有记录，不覆盖。
   */
  async function insertPayment(payment: Payment): Promise<void> {
    const values = paymentValues(payment);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await db.query<PaymentRow>(
        `INSERT INTO payments (${PAYMENT_COLUMNS})
         VALUES (${placeholders(values.length)})
         ON CONFLICT (payment_request_id) DO NOTHING
         RETURNING ${PAYMENT_COLUMNS}`,
        values,
      );
      if (inserted[0]) return;

      const existing = await db.query<PaymentRow>(
        `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE payment_request_id = $1`,
        [payment.paymentRequestId],
      );
      if (existing[0]) return;
    }

    throw new Error(`支付记录写入在并发下未能收敛（支付请求 ${payment.paymentRequestId}）。`);
  }

  async function countOrders(
    userId: string,
    status: OrderStatus | null,
    keyword: string,
  ): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM orders
        WHERE user_id = $1
          AND ($2::text IS NULL OR status = $2::text)
          AND position(lower($3::text) in lower(order_no)) > 0`,
      [userId, status, keyword],
    );
    return rows[0]?.total ?? 0;
  }

  return {
    findPaymentRequestByKey,
    findPaymentRequestById,

    async createPaymentRequest(request) {
      const values = paymentRequestValues(request);

      // 单条 INSERT … ON CONFLICT DO NOTHING：由唯一索引决定这次是新建还是命中，
      // 代码不参与判断（消灭 Mock 里「先查 key 再写」的 TOCTOU 窗口）。
      // 最多两轮：第二轮只在「冲突命中后、回读之前，那行被并发删掉」时发生。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<PaymentRequestRow>(
          `INSERT INTO payment_requests (${PAYMENT_REQUEST_COLUMNS})
           VALUES (${placeholders(values.length)})
           ON CONFLICT (user_id, idempotency_key) DO NOTHING
           RETURNING ${PAYMENT_REQUEST_COLUMNS}`,
          values,
        );
        if (inserted[0]) return { request: toPaymentRequest(inserted[0]), created: true };

        const existing = await findPaymentRequestByKey(request.userId, request.idempotencyKey);
        if (existing) return { request: existing, created: false };

        // 既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `支付请求写入在并发下未能收敛（用户 ${request.userId} / 幂等键 ${request.idempotencyKey}）。`,
      );
    },

    async confirmPaymentRequest(id, result, buildOrder) {
      const requestRows = await db.query<PaymentRequestRow>(
        `SELECT ${PAYMENT_REQUEST_COLUMNS} FROM payment_requests WHERE id = $1`,
        [id],
      );
      if (!requestRows[0]) return null;
      const request = toPaymentRequest(requestRows[0]);

      // 已是终态：原样返回既有结果。重复确认成功不会生成第二个订单。
      if (request.status !== "pending") {
        const settledOrder = request.orderId ? await findOrderById(request.orderId) : null;
        return { request, order: settledOrder, orderCreated: false };
      }

      const status = RESULT_TO_STATUS[result];

      // —— 认领 pending → 终态（原子闸门）——
      // 与 Mock 里那段无 `await` 的「检查是不是 pending、然后置终态」等价：
      // 并发下只有一个请求能把行从 pending 改走，后到的会阻塞到锁释放，重新求值
      // `WHERE`，发现 status 已不是 pending，于是改 0 行——走下面的「重复确认」分支。
      // `confirmed_at` 由数据库的 `now()` 给出（与 Mock 的 `new Date()` 同一含义，
      // 但不在仓储里取墙钟），随 `RETURNING` 还原成 ISO 字符串。
      const claimedRows = await db.query<PaymentRequestRow>(
        `UPDATE payment_requests
            SET status = $2, confirmed_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING ${PAYMENT_REQUEST_COLUMNS}`,
        [id, status],
      );
      if (!claimedRows[0]) {
        // 竞态失败：另一个并发确认先赢了。读回终态与它生成的订单，按「重复确认」回答。
        const settled = await findPaymentRequestById(id);
        if (!settled) return null;
        const settledOrder = settled.orderId ? await findOrderById(settled.orderId) : null;
        return { request: settled, order: settledOrder, orderCreated: false };
      }
      const claimed = toPaymentRequest(claimedRows[0]);

      // 失败 / 取消：只改状态，不生成订单（与 Mock 一致）
      if (status !== "success") {
        return { request: claimed, order: null, orderCreated: false };
      }

      // 订单长什么样属于业务，由 service 传入的纯函数决定；仓储只负责「恰好生成一次」。
      // 传的是**认领之前**的那份 request（与 Mock 传 `request` 一致），它只读快照与金额，
      // 不读 status / confirmedAt。⚠️ 这一步可能抛错（如券不可用），
      // 因此整个方法必须跑在调用方的事务里——抛错时认领的那一行随之回滚。
      const order = buildOrder(request);

      // —— 原子区段（由调用方的数据库事务提供）——
      await insertOrder(order);

      // ⚠️ `amount` 是**实付**（`actualPaidAmount`），不是 `totalAmount`（P1-4 修正）。
      // `paidAt` 直接取认领那一刻写下的 `confirmed_at`，与 Mock 用同一个 `now` 一致。
      const confirmedAt = claimed.confirmedAt;
      if (confirmedAt === null) {
        // 刚刚 `SET confirmed_at = now()` 过，为 null 属于不可能状态
        throw new Error(`支付请求确认后 confirmed_at 仍为空（支付请求 ${id}）。`);
      }
      await insertPayment({
        id: `pay_${crypto.randomUUID()}`,
        paymentRequestId: claimed.id,
        orderId: order.id,
        userId: claimed.userId,
        amount: claimed.actualPaidAmount,
        status: "success",
        paidAt: confirmedAt,
      });

      // 订单号回填到支付请求（与 Mock 的 `updated.orderId` 是同一处事实）。
      // 放在订单插入**之后**：`payment_requests.order_id` 有指向 `orders(id)` 的外键。
      const linkedRows = await db.query<PaymentRequestRow>(
        `UPDATE payment_requests SET order_id = $2 WHERE id = $1
         RETURNING ${PAYMENT_REQUEST_COLUMNS}`,
        [id, order.id],
      );
      const linked = linkedRows[0] ? toPaymentRequest(linkedRows[0]) : claimed;
      // —— 原子区段结束 ——

      return { request: linked, order, orderCreated: true };
    },

    async queryOrders({ userId, status, keyword, page, pageSize }): Promise<PageResult<Order>> {
      const start = (page - 1) * pageSize;

      // total 与当前页在**同一条语句**里取（窗口函数），看到的是同一个快照。
      // 排序完全对齐 compareOrdersNewestFirst：paid_at DESC, created_at DESC, id DESC。
      // ⚠️ 时间列在边界上都是 canonical ISO 8601 UTC 字符串（定长 + Z），**字典序即时间序**，
      // 因此 SQL 的 timestamptz 排序与 Mock 的字符串比较给出同一结果；id 兜底保证排序完全确定，
      // 否则分页会在同一时刻的两单之间重复或漏掉。
      //
      // 关键词用 position(lower($3) in lower(order_no)) > 0，而不是 ILIKE '%'||$3||'%'：
      // 后者会把用户输入里的 % / _ 当成通配符，而 Mock 的 matchesOrderKeyword 要的是
      // 忽略大小写的**字面量包含**。position('' in x) = 1 > 0，空关键词天然「不过滤」。
      const rows = await db.query<OrderRow & { total: number }>(
        `SELECT ${ORDER_COLUMNS}, (count(*) OVER ())::int AS total
           FROM orders
          WHERE user_id = $1
            AND ($2::text IS NULL OR status = $2::text)
            AND position(lower($3::text) in lower(order_no)) > 0
          ORDER BY paid_at DESC, created_at DESC, id DESC
          LIMIT $4 OFFSET $5`,
        [userId, status, keyword, pageSize, start],
      );

      // 翻到超出末页时窗口函数没有行可依附，拿不到 total：
      // 这种情况只发生在越界页，补一次计数即可（`page === 1` 时空结果就是 total = 0）
      const total =
        rows.length > 0 ? rows[0].total : page > 1 ? await countOrders(userId, status, keyword) : 0;
      const items = rows.map(toOrder);

      return {
        items,
        page,
        pageSize,
        total,
        // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
        hasMore: start + items.length < total,
      };
    },

    findOrderById,

    async listOrdersByUser(userId) {
      // Mock 不排序（消费统计与顺序无关），但 SQL 的未排序结果是**不确定**的，
      // 因此这里补一个与其它列表一致的全序。统计口径不依赖顺序，业务结果不变。
      const rows = await db.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = $1
          ORDER BY created_at DESC, id DESC`,
        [userId],
      );
      return rows.map(toOrder);
    },

    async queryOrdersByCompanion(companionId) {
      // 条件就是 `actual_companion_id`（**实际履约**的人），不是派单的 `exclusive_companion_id`。
      // 排序对齐 `compareOrdersNewestFirst`：`paid_at DESC, created_at DESC, id DESC`。
      const rows = await db.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE actual_companion_id = $1
          ORDER BY paid_at DESC, created_at DESC, id DESC`,
        [companionId],
      );
      return rows.map(toOrder);
    },

    async listAllOrders() {
      // 与 listOrdersByUser 同一取舍：Mock 不带顺序，SQL 需要一个全序才确定；
      // 排行榜是聚合消费，顺序不影响结果。
      const rows = await db.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders ORDER BY created_at DESC, id DESC`,
      );
      return rows.map(toOrder);
    },

    async queryOrdersForAdmin(filter: AdminOrderQueryFilter) {
      // 四个 WHERE 条件对齐 `AdminOrderQueryFilter` 的三个筛选维度（日期范围拆成 from / to 两侧）：
      // - `status`：null 表示全部；
      // - `gameName`：空串表示全部游戏，按**下单时的名称快照**匹配（`game_name` 列）；
      // - `from` / `to`：空串表示该侧不限，按**北京时间自然日**比较。
      //
      // ⚠️ 日期用 `to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')` 取出
      // 「北京时间的哪一天」，再与原样的 `YYYY-MM-DD` 字符串做字典序比较——
      // 这正是 `orderBeijingDate` + `orderInDateRange` 的逐字等价：
      //   * `Asia/Shanghai` 全年 UTC+8，与 `formatDateTime` 的固定 +8 小时一致；
      //   * `YYYY-MM-DD` 定长，字典序即日期序，与 JS 的 `date < from` 是同一种比较。
      // 排序对齐 `compareOrdersForAdmin`（`compareOrdersByCreatedAt`）：
      // `created_at DESC, paid_at DESC, id ASC`——⚠️ 注意 id 是**升序**，
      // 与用户端 `compareOrdersNewestFirst` 的 id 降序**刻意不同**，不是笔误。
      const rows = await db.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders
          WHERE ($1::text IS NULL OR status = $1::text)
            AND ($2::text = '' OR game_name = $2::text)
            AND ($3::text = '' OR
                 to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') >= $3::text)
            AND ($4::text = '' OR
                 to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') <= $4::text)
          ORDER BY created_at DESC, paid_at DESC, id ASC`,
        [filter.status, filter.gameName, filter.from, filter.to],
      );
      return rows.map(toOrder);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 *
 * ⚠️ `confirmPaymentRequest` / `createPaymentRequest` 的原子性依赖调用方传入的事务句柄，
 * 进程级实例只适合读取方法与单条语句，不要用它承载需要原子性的业务链。
 */
export const pgPaymentRepository: PaymentRepository = createPaymentRepository(lazyPgExecutor());
