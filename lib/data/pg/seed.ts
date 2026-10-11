import { agreementSeed } from "@/lib/mocks/fixtures/agreementSeed";
import { adminSeed } from "@/lib/mocks/fixtures/adminSeed";
import { categorySeed, gameSeed, productSeed } from "@/lib/mocks/fixtures/catalogSeed";
import { companionApplicationSeed } from "@/lib/mocks/fixtures/companionApplicationSeed";
import { announcementSeed, bannerSeed, quickEntrySeed } from "@/lib/mocks/fixtures/contentSeed";
import { favoriteSeed } from "@/lib/mocks/fixtures/favoriteSeed";
import { suggestionSeed } from "@/lib/mocks/fixtures/suggestionSeed";
import { buildDispatchSeed } from "@/lib/mocks/fixtures/dispatchSeed";
import { levelSeed } from "@/lib/mocks/fixtures/levelSeed";
import { conversationSeed, messageSeed, staffReadSeed } from "@/lib/mocks/fixtures/messageSeed";
import { getMockSeedNow } from "@/lib/mocks/fixtures/mockClock";
import { complaintSeed } from "@/lib/mocks/fixtures/complaintSeed";
import { couponClaimSeed, couponSeed } from "@/lib/mocks/fixtures/couponSeed";
import { notificationSeed } from "@/lib/mocks/fixtures/notificationSeed";
import { buildRankingPeriodOrders, orderSeed } from "@/lib/mocks/fixtures/orderSeed";
import { platformConfigSeed } from "@/lib/mocks/fixtures/platformConfigSeed";
import { refundSeed } from "@/lib/mocks/fixtures/refundSeed";
import { reviewSeed } from "@/lib/mocks/fixtures/reviewSeed";
import { companionSeed, userSeed } from "@/lib/mocks/fixtures/seed";
import { staffSeed } from "@/lib/mocks/fixtures/staffSeed";
import { tipSeed } from "@/lib/mocks/fixtures/tipSeed";
import { assertSeedAllowed } from "./config";
import type { PgExecutor, PgQueryable } from "./executor";

/**
 * 开发 / 测试环境的预置数据写入（**仅服务端**）。
 *
 * ## 为什么直接复用 `lib/mocks/fixtures/*`
 *
 * 因为竖切片要证明的事情之一是「**Mock 与 PostgreSQL 在同一份数据上给出一致结果**」。
 * 若给数据库另写一套种子，两个实现比的就不是同一份输入，
 * 「结果一致」也就说明不了任何问题。复用同一份 `favoriteSeed` / `suggestionSeed`，
 * 连 id、时间戳、边界用例（已下架商品、已删除商品、另一个用户的收藏、
 * 三个状态的反馈）都完全对齐。
 *
 * ## 幂等
 *
 * 一律 `ON CONFLICT DO NOTHING`：重复执行不会报错，也不会产生第二份数据。
 * 这是 seed 与 migration 的语义差别——migration「跑过就不跑」，seed「跑几次都一样」。
 *
 * ⚠️ 预置数据里的 `createdAt` 全部是**写死的**常量（不是 `now()`），
 * 所以「reset 之后数据是确定的」这句话才成立：每一轮的排序、分页、
 * 边界位置都落在同一处。
 */

export type SeedCounts = { inserted: number; skipped: number };

export type SeedResult = {
  favorites: SeedCounts;
  suggestions: SeedCounts;
  // —— PROD-1B · W1 订单写闭包。下面这些表**都真的有预置数据**，
  //    因此必须与 Mock 装同一份；本文件里出现它们，正是「同一份输入」的落点。——
  companions: SeedCounts;
  orders: SeedCounts;
  dispatchRecords: SeedCounts;
  couponTemplates: SeedCounts;
  couponClaims: SeedCounts;
  notifications: SeedCounts;
  complaints: SeedCounts;
  refundRequests: SeedCounts;
  platformConfig: SeedCounts;

  // —— PROD-1E · 剩余业务域的预置数据。
  //    与 W1 同一原则：Mock 建仓时装了什么，这里就写什么（含「两边都空」）。
  //    新增表全部落在 `0010`–`0016` 七个迁移里。——
  users: SeedCounts;
  adminAccounts: SeedCounts;
  staffAccounts: SeedCounts;
  games: SeedCounts;
  categories: SeedCounts;
  products: SeedCounts;
  productSpecs: SeedCounts;
  announcements: SeedCounts;
  banners: SeedCounts;
  quickEntries: SeedCounts;
  agreements: SeedCounts;
  companionApplications: SeedCounts;
  /** ⚠️ 与 Mock 一样是**空的**（`mockQualificationRepository.createStore()`）——理由见该文件头。 */
  userQualifications: SeedCounts;
  consumptionLevels: SeedCounts;
  tipRecords: SeedCounts;
  orderReviews: SeedCounts;
  conversations: SeedCounts;
  messages: SeedCounts;
  staffReads: SeedCounts;
};

/**
 * ⚠️ W1 的这几张表在 Mock 里**建仓时是空的**，因此 PG 侧同样不写任何行：
 *
 * `payment_requests` · `payments`（`mockPaymentRepository.createStore` 里都是 `new Map()`）、
 * `completion_submissions`（`mockCompletionRepository`）、
 * `earnings` / `earning_adjustments`（`mockEarningRepository`）、
 * `companion_accept_events` / `companion_release_records` / `companion_service_events`
 * （三张只增不改的历史表，建仓即为空）。
 *
 * 「两边都空」也是 parity 的一部分。给它们编一份预置数据，等于凭空造出一段
 * 从未发生过的历史——而那正是 `deriveLegacyAcceptEvents` 反复强调不许做的事。
 */

/**
 * 先校验预置数据自身没有重复，再往库里写。
 *
 * ⚠️ 这两条检查是**必须**的，因为下面的插入统一用 `ON CONFLICT DO NOTHING`（不带冲突目标）。
 * 不带目标的写法会把**任何**唯一键冲突都当成「这行已经在了」而跳过——
 * 于是「种子里两条收藏撞了同一个 (用户, 商品)」这种数据错误会**静默少写一条**，
 * 而所有检查都显示正常。把重复挡在插入之前，`DO NOTHING` 就只可能在
 * 「重跑同一份种子」这种正当场景下生效。
 *
 * 这两条不变量与 `mockFavoriteRepository.createStore()` / `mockSuggestionRepository.createStore()`
 * 在建仓时做的检查是同一组——两个实现在同一份种子上必须表现出同样的行为。
 */
function assertSeedFixtures(): void {
  const favoriteIds = new Set<string>();
  const favoriteKeys = new Set<string>();
  for (const favorite of favoriteSeed) {
    if (favoriteIds.has(favorite.id)) {
      throw new Error(`预置收藏数据出现重复 id：${favorite.id}`);
    }
    favoriteIds.add(favorite.id);

    const key = `${favorite.userId}:${favorite.productId}`;
    if (favoriteKeys.has(key)) {
      throw new Error(`预置收藏数据重复：${key}`);
    }
    favoriteKeys.add(key);
  }

  const suggestionIds = new Set<string>();
  for (const suggestion of suggestionSeed) {
    if (suggestionIds.has(suggestion.id)) {
      throw new Error(`预置反馈数据出现重复 id：${suggestion.id}`);
    }
    suggestionIds.add(suggestion.id);
  }
}

/** 逐行检查某个键不重复。命中重复就抛，绝不留给 `ON CONFLICT DO NOTHING` 去静默吞掉。 */
function assertNoDuplicateKey<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) throw new Error(`${label}出现重复：${key}`);
    seen.add(key);
  }
}

/**
 * W1 预置数据的**唯一性**预检（PROD-1B）。
 *
 * ## 只查唯一性，不查业务规则
 *
 * 判据是「这条错误会不会被 `ON CONFLICT DO NOTHING` 吞掉」：
 *
 * - **会被吞**：任何唯一约束冲突。种子若有两条同行，`DO NOTHING` 会让第二条
 *   悄悄消失，而所有检查都显示正常 → 必须在插入**之前**查出来。
 *   这里查的 id / 单号 / 业务键都属于这一类。
 * - **不会被吞**：CHECK 与 FK 违规。它们照样抛错、指名道姓地报出是哪一条约束。
 *   在 JS 里再实现一遍等于给同一条规则建第二个真值源——**刻意不做**。
 *
 * ## 这些检查与 Mock 建仓行为的关系
 *
 * Mock 侧大多**不查**这些：`mockCouponRepository` 的 `new Map(claimIdByCoupon)`、
 * `mockDispatchRepository` 的 `new Map(dispatchIdByOrder)` 遇到重复键都是**后者覆盖**，
 * 一样是静默的。因此这里查出来的是一个**两边都有的**数据缺陷，
 * 而不是 Pg 侧额外强加的要求。
 */
function assertOrderHubFixtures(): void {
  const seedNow = getMockSeedNow();
  const orders = [...orderSeed, ...buildRankingPeriodOrders(seedNow)];
  const dispatches = buildDispatchSeed(orders, seedNow);

  assertNoDuplicateKey(companionSeed, (companion) => companion.id, "预置护航数据 id ");
  assertNoDuplicateKey(
    companionSeed.filter((companion) => companion.userId !== null && companion.removedAt === null),
    (companion) => companion.userId ?? "",
    "预置护航数据「一名用户一条有效记录」",
  );

  assertNoDuplicateKey(orders, (order) => order.id, "预置订单数据 id ");
  assertNoDuplicateKey(orders, (order) => order.orderNo, "预置订单数据 orderNo ");

  assertNoDuplicateKey(dispatches, (record) => record.id, "预置派单数据 id ");
  assertNoDuplicateKey(dispatches, (record) => record.orderId, "预置派单数据「一单一派单」");

  assertNoDuplicateKey(couponSeed, (template) => template.id, "预置券模板数据 id ");
  assertNoDuplicateKey(couponClaimSeed, (claim) => claim.id, "预置领券数据 id ");
  assertNoDuplicateKey(
    couponClaimSeed.filter((claim) => claim.source === "self_claim"),
    (claim) => `${claim.userId}:${claim.couponId}`,
    "预置领券数据「一人一券」",
  );

  assertNoDuplicateKey(notificationSeed, (item) => item.id, "预置通知数据 id ");

  assertNoDuplicateKey(complaintSeed, (complaint) => complaint.id, "预置投诉数据 id ");
  assertNoDuplicateKey(complaintSeed, (complaint) => complaint.complaintNo, "预置投诉数据 complaintNo ");

  assertNoDuplicateKey(refundSeed, (refund) => refund.id, "预置退款数据 id ");
  assertNoDuplicateKey(refundSeed, (refund) => refund.refundNo, "预置退款数据 refundNo ");
  assertNoDuplicateKey(refundSeed, (refund) => refund.orderId, "预置退款数据「一单一退」");
}

/**
 * PROD-1E 新增域的**唯一性**预检。
 *
 * 判据与 `assertOrderHubFixtures` 完全一致——只查「会被 `ON CONFLICT DO NOTHING`
 * 吞掉」的那一类错误（即唯一约束冲突），不重实现 CHECK / FK：那些本来就会抛错，
 * 再在 JS 里写一遍等于给同一条规则建第二个真值源。
 *
 * ⚠️ 这里的每一项都能在 Mock 侧找到对应的**静默**行为，因此查的是两边共有的数据缺陷，
 * 而不是 Pg 额外强加的要求：
 *
 * - `admin_accounts` / `staff_accounts` 的 `lower(btrim(username))`：Mock 的
 *   `findStaffWithUsername` 也是这么比的，两条同名账号会让登录命中哪一条取决于插入顺序；
 * - `companion_applications.user_id`：Mock 是一个以 `userId` 为键的 Map，重复即**后者覆盖**；
 * - `order_reviews (user_id, order_id)`：Mock 建仓时**会抛**（`mockReviewRepository`
 *   的 `createStore`），这里保持同一口径，让 Pg 侧在写库之前就报出同一条错误。
 */
function assertPlatformFixtures(): void {
  assertNoDuplicateKey(userSeed, (user) => user.id, "预置用户数据 id ");
  assertNoDuplicateKey(adminSeed, (admin) => admin.id, "预置管理员数据 id ");
  assertNoDuplicateKey(
    adminSeed,
    (admin) => admin.username.trim().toLowerCase(),
    "预置管理员数据「登录名（忽略大小写与首尾空白）」",
  );
  assertNoDuplicateKey(staffSeed, (staff) => staff.id, "预置客服数据 id ");
  assertNoDuplicateKey(
    staffSeed,
    (staff) => staff.username.trim().toLowerCase(),
    "预置客服数据「登录名（忽略大小写与首尾空白）」",
  );

  assertNoDuplicateKey(gameSeed, (game) => game.id, "预置游戏数据 id ");
  assertNoDuplicateKey(categorySeed, (category) => category.id, "预置类目数据 id ");
  assertNoDuplicateKey(
    categorySeed.filter((category) => category.removedAt === null),
    (category) => `${category.gameId}:${category.name.trim()}`,
    "预置类目数据「同游戏内未移除类目重名」",
  );
  assertNoDuplicateKey(productSeed, (product) => product.id, "预置商品数据 id ");
  assertNoDuplicateKey(
    productSeed.flatMap((product) => product.specs),
    (spec) => spec.id,
    "预置商品规格数据 id ",
  );

  assertNoDuplicateKey(announcementSeed, (item) => item.id, "预置公告数据 id ");
  assertNoDuplicateKey(bannerSeed, (item) => item.id, "预置活动图数据 id ");
  assertNoDuplicateKey(quickEntrySeed, (item) => item.id, "预置快捷入口数据 id ");

  assertNoDuplicateKey(agreementSeed, (item) => item.id, "预置协议数据 id ");
  assertNoDuplicateKey(
    agreementSeed,
    (item) => `${item.type}:${item.version}`,
    "预置协议数据「同类型同版本」",
  );

  assertNoDuplicateKey(companionApplicationSeed, (item) => item.id, "预置入驻申请数据 id ");
  assertNoDuplicateKey(
    companionApplicationSeed,
    (item) => item.userId,
    "预置入驻申请数据「一人一申请」",
  );

  assertNoDuplicateKey(levelSeed, (level) => level.id, "预置消费等级数据 id ");
  assertNoDuplicateKey(tipSeed, (tip) => tip.id, "预置鸡腿记录数据 id ");

  assertNoDuplicateKey(reviewSeed, (review) => review.id, "预置评价数据 id ");
  assertNoDuplicateKey(
    reviewSeed,
    (review) => `${review.userId}:${review.orderId}`,
    "预置评价数据「一单一评」",
  );

  assertNoDuplicateKey(conversationSeed, (item) => item.id, "预置会话数据 id ");
  assertNoDuplicateKey(
    conversationSeed.filter((item) => item.kind === "service"),
    (item) => item.orderId,
    "预置会话数据「一单一条客服会话」",
  );
  assertNoDuplicateKey(
    conversationSeed.filter((item) => item.kind === "assignment"),
    (item) => `${item.orderId}:${item.assignmentKey ?? ""}`,
    "预置会话数据「同订单同履约段唯一」",
  );
  assertNoDuplicateKey(messageSeed, (message) => message.id, "预置消息数据 id ");
  assertNoDuplicateKey(
    staffReadSeed,
    (record) => `${record.orderId}:${record.staffId}`,
    "预置客服已读数据「订单 + 客服唯一」",
  );
}

/**
 * 预置收藏。
 *
 * ⚠️ `ON CONFLICT DO NOTHING` **刻意不带冲突目标**。看上去 `(user_id, product_id)`
 * 更精确，但它接不住一种很常见的开发场景：从界面上取消收藏（列表少了一条），
 * 再跑一次 seed —— 这时业务键不再冲突，插入会撞上主键 `favorites_pkey` 而报错。
 * 种子要的是「确保这些行存在」，任何唯一键冲突都只说明「它已经在某种形式下存在了」。
 * 数据本身的重复由 `assertSeedFixtures` 提前挡住，所以这里不会掩盖真实错误。
 */
async function seedFavorites(executor: PgQueryable): Promise<SeedCounts> {
  let inserted = 0;

  for (const favorite of favoriteSeed) {
    const rows = await executor.query<{ id: string }>(
      `INSERT INTO favorites (id, user_id, product_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [favorite.id, favorite.userId, favorite.productId, favorite.createdAt],
    );
    if (rows.length > 0) inserted += 1;
  }

  return { inserted, skipped: favoriteSeed.length - inserted };
}

/**
 * 预置反馈。
 *
 * ⚠️ `idempotency_key` 写 NULL，**照抄 Mock 的语义**：`mockSuggestionRepository.createStore()`
 * 只把种子放进 `suggestions`，并不往 `suggestionIdByKey` 里放东西，
 * 所以预置反馈在 Mock 里是「按幂等键查不到」的。NULL 在 UNIQUE 里互不冲突，
 * 两个实现对同一份种子的行为因此完全一致。理由详见 `db/migrations/0002_suggestions.sql`。
 *
 * ⚠️ 正因为键是 NULL，`ON CONFLICT (user_id, idempotency_key)` 这个写法在这里**是错的**：
 * 它接不住重复插入（NULL 互不冲突），重跑 seed 会直接撞上 `suggestions_pkey`。
 * 所以这里与收藏一样用不带目标的 `DO NOTHING`。
 */
async function seedSuggestions(executor: PgQueryable): Promise<SeedCounts> {
  let inserted = 0;

  for (const suggestion of suggestionSeed) {
    const rows = await executor.query<{ id: string }>(
      `INSERT INTO suggestions (
         id, user_id, type_key, type_label, content, contact,
         evidence, status, reply, replied_at, created_at, idempotency_key
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NULL)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        suggestion.id,
        suggestion.userId,
        suggestion.typeKey,
        suggestion.typeLabel,
        suggestion.content,
        suggestion.contact,
        JSON.stringify(suggestion.evidence),
        suggestion.status,
        suggestion.reply,
        suggestion.repliedAt,
        suggestion.createdAt,
      ],
    );
    if (rows.length > 0) inserted += 1;
  }

  return { inserted, skipped: suggestionSeed.length - inserted };
}

// ————————————————————— PROD-1B · W1 订单写闭包 —————————————————————

/**
 * 通用的「逐行插入」。
 *
 * ## 为什么要一个通用件，而不是每张表手写一遍 INSERT
 *
 * 因为 17 张表里有 9 张要写数据，其中 `orders` 一张就有 38 列。手写 9 段
 * 列名与占位符一一对应的 SQL，出错的方式是**静默的**：列顺序与值顺序错位时，
 * 只要类型都对得上，PostgreSQL 会照单全收——把 `completed_at` 写进 `serving_at`
 * 不会报任何错，只会让一条历史记录说谎。抽成「列定义 + 取值函数」之后，
 * 错位只有在**同一个列表里**才可能发生，而那个列表就在取值函数的正上方。
 *
 * ## 与 PROD-1A 那两张表的差别
 *
 * `seedFavorites` / `seedSuggestions` 保持手写：它们是已交付、已被证明的实现，
 * 本轮不改（Hard Rule 2 的同一精神——不顺手重构已验证的东西）。
 */

type SeedColumn = { name: string; cast?: string };

/**
 * jsonb 列的入参。
 *
 * ⚠️ `null` 必须**原样**交给驱动，不能 `JSON.stringify(null)`：
 * 后者得到字符串 `"null"`，PG 会把它解析成 JSON 的 `null` 值而不是 SQL NULL。
 * 两者在 `IS NULL` 判断下结果相反，而 `orders.coupon` 正是靠 NULL 表示「没用券」。
 */
function jsonbParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function insertSql(table: string, columns: SeedColumn[]): string {
  const placeholders = columns.map((column, index) =>
    column.cast ? `$${index + 1}::${column.cast}` : `$${index + 1}`,
  );
  return [
    `INSERT INTO ${table} (${columns.map((column) => column.name).join(", ")})`,
    `VALUES (${placeholders.join(", ")})`,
    "ON CONFLICT DO NOTHING",
    "RETURNING 1 AS inserted",
  ].join("\n");
}

async function seedRows<T>(
  executor: PgQueryable,
  table: string,
  columns: SeedColumn[],
  rows: readonly T[],
  toValues: (row: T) => unknown[],
): Promise<SeedCounts> {
  const sql = insertSql(table, columns);
  let inserted = 0;
  for (const row of rows) {
    const result = await executor.query<{ inserted: number }>(sql, toValues(row));
    if (result.length > 0) inserted += 1;
  }
  return { inserted, skipped: rows.length - inserted };
}

const COMPANION_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "user_id" },
  { name: "application_id" },
  { name: "removed_at" },
  { name: "display_name" },
  { name: "avatar_url" },
  { name: "rank_label" },
  { name: "intro" },
  { name: "game_ids", cast: "jsonb" },
  { name: "regions", cast: "jsonb" },
  { name: "service_tags", cast: "jsonb" },
  { name: "available" },
  { name: "unavailable_reason" },
  { name: "enabled" },
  { name: "completed_order_count" },
  { name: "tips_count" },
  { name: "sort_order" },
];

const ORDER_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "order_no" },
  { name: "user_id" },
  { name: "status" },
  { name: "created_at" },
  { name: "paid_at" },
  { name: "accepted_at" },
  { name: "serving_at" },
  { name: "completed_at" },
  { name: "refunded_at" },
  { name: "ever_accepted_at" },
  { name: "product_id" },
  { name: "product_title" },
  { name: "product_cover_url" },
  { name: "spec_id" },
  { name: "spec_name" },
  { name: "unit_price" },
  { name: "quantity" },
  { name: "game_name" },
  { name: "region" },
  { name: "game_account_id" },
  { name: "remark" },
  { name: "addons", cast: "jsonb" },
  { name: "items_amount" },
  { name: "addons_amount" },
  { name: "total_amount" },
  { name: "original_amount" },
  { name: "coupon_discount_amount" },
  { name: "actual_paid_amount" },
  { name: "companion_rate_snapshot" },
  { name: "companion_base_income" },
  { name: "club_net_income" },
  { name: "refunded_amount" },
  { name: "coupon", cast: "jsonb" },
  { name: "actual_companion_id" },
  { name: "companion", cast: "jsonb" },
  { name: "complaint_window_minutes_snapshot" },
  { name: "complaint_deadline_at" },
];

const DISPATCH_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "order_id" },
  { name: "state" },
  { name: "exclusive_companion_id" },
  { name: "exclusive_entered_at" },
  { name: "exclusive_deadline_at" },
  { name: "exclusive_timeout_minutes_snapshot" },
  { name: "public_pool_entered_at" },
  { name: "public_deadline_at" },
  { name: "public_timeout_minutes_snapshot" },
  { name: "accepted_by_companion_id" },
  { name: "accepted_at" },
  { name: "accepted_via" },
  { name: "timed_out_at" },
  { name: "created_at" },
  { name: "updated_at" },
];

const COUPON_TEMPLATE_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "name" },
  { name: "form_key" },
  { name: "form_label" },
  { name: "value_label" },
  { name: "condition_label" },
  { name: "valid_from" },
  { name: "valid_to" },
  { name: "threshold_amount" },
  { name: "discount_amount" },
  { name: "enabled" },
  { name: "created_at" },
  { name: "updated_at" },
];

const COUPON_CLAIM_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "user_id" },
  { name: "coupon_id" },
  { name: "status" },
  { name: "source" },
  { name: "claimed_at" },
  { name: "used_at" },
  { name: "granted_by_admin_id" },
  { name: "idempotency_key" },
  { name: "snapshot", cast: "jsonb" },
];

const NOTIFICATION_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "user_id" },
  { name: "kind" },
  { name: "title" },
  { name: "summary" },
  { name: "body" },
  { name: "created_at" },
  { name: "read_at" },
  { name: "href" },
];

const COMPLAINT_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "complaint_no" },
  { name: "user_id" },
  { name: "order_id" },
  { name: "order_no" },
  { name: "status" },
  { name: "type_key" },
  { name: "type_label" },
  { name: "description" },
  { name: "evidence", cast: "jsonb" },
  { name: "contact" },
  { name: "idempotency_key" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "processing_at" },
  { name: "handled_at" },
  { name: "handled_by_id" },
  { name: "handled_by_role" },
  { name: "handled_by_name" },
  { name: "result" },
];

const REFUND_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "refund_no" },
  { name: "user_id" },
  { name: "order_id" },
  { name: "status" },
  { name: "amount" },
  { name: "decision", cast: "jsonb" },
  { name: "reason_key" },
  { name: "reason_label" },
  { name: "description" },
  { name: "evidence", cast: "jsonb" },
  { name: "idempotency_key" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "reviewing_at" },
  { name: "reviewed_at" },
  { name: "reviewed_by" },
  { name: "reviewed_by_role" },
  { name: "reviewed_by_name" },
  { name: "review_note" },
  { name: "cancelled_at" },
];

const PLATFORM_CONFIG_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "exclusive_pool_timeout_minutes" },
  { name: "public_pool_timeout_minutes" },
  { name: "completion_auto_approval_minutes" },
  { name: "complaint_window_minutes" },
  { name: "updated_at" },
  { name: "updated_by_admin_id" },
];

// ————————————————— PROD-1E · 剩余业务域（0010–0016） —————————————————

const USER_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "display_id" },
  { name: "nickname" },
  { name: "avatar_url" },
  { name: "bio" },
];

const ADMIN_ACCOUNT_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "username" },
  { name: "display_name" },
  { name: "role" },
  { name: "enabled" },
  { name: "last_login_at" },
];

const STAFF_ACCOUNT_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "username" },
  { name: "display_name" },
  { name: "avatar_url" },
  { name: "role" },
  { name: "enabled" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "last_login_at" },
  { name: "removed_at" },
];

const GAME_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "name" },
  { name: "regions", cast: "jsonb" },
];

const CATEGORY_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "game_id" },
  { name: "name" },
  { name: "sort_order" },
  { name: "enabled" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "removed_at" },
];

/**
 * ⚠️ 商品**没有价格列**：价格在规格上（`product_specs.price`）。
 * 这里如果顺手写一个 `price`，就会出现「商品一个价、规格另一个价」的第二处真值源。
 */
const PRODUCT_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "title" },
  { name: "subtitle" },
  { name: "cover_url" },
  { name: "game_id" },
  { name: "category_id" },
  { name: "tags", cast: "jsonb" },
  { name: "detail_text" },
  { name: "detail_images", cast: "jsonb" },
  { name: "sort_order" },
  { name: "recommended" },
  { name: "status" },
  { name: "monthly_sales" },
  { name: "game_tag" },
  { name: "companion_rate_bp" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "removed_at" },
];

const PRODUCT_SPEC_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "product_id" },
  { name: "name" },
  { name: "price" },
  { name: "sort_order" },
  { name: "enabled" },
  { name: "removed_at" },
];

const ANNOUNCEMENT_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "title" },
  { name: "image_url" },
  { name: "alt" },
  { name: "enabled" },
  { name: "sort_order" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "removed_at" },
];

/** 活动图与公告同形（`ContentBannerRecord` 的注释：两者都是「一张图 + 一个后台标题」）。 */
const BANNER_COLUMNS: SeedColumn[] = ANNOUNCEMENT_COLUMNS;

const QUICK_ENTRY_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "label" },
  { name: "icon" },
  { name: "path" },
  { name: "enabled" },
  { name: "sort_order" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "removed_at" },
];

/** ⚠️ 协议**没有 `created_at`**：实体里只有 `updatedAt`（`Agreement`），表与它同形。 */
const AGREEMENT_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "type" },
  { name: "title" },
  { name: "sections", cast: "jsonb" },
  { name: "version" },
  { name: "updated_at" },
  { name: "enabled" },
];

const COMPANION_APPLICATION_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "application_no" },
  { name: "user_id" },
  { name: "display_name" },
  { name: "game_ids", cast: "jsonb" },
  { name: "regions", cast: "jsonb" },
  { name: "service_tags", cast: "jsonb" },
  { name: "experience" },
  { name: "introduction" },
  { name: "contact_note" },
  { name: "evidence", cast: "jsonb" },
  { name: "status" },
  { name: "submitted_at" },
  { name: "updated_at" },
  { name: "reviewed_at" },
  { name: "review_note" },
  { name: "idempotency_key" },
];

/**
 * ⚠️ `user_qualifications` **没有单列 id**：自然键 `(user_id, role)` 就是主键
 * （`0013_companion_onboarding.sql`），因此这里也不出现 `id`。
 */
const QUALIFICATION_COLUMNS: SeedColumn[] = [
  { name: "user_id" },
  { name: "role" },
  { name: "companion_id" },
  { name: "application_id" },
  { name: "granted_at" },
  { name: "granted_by_admin_id" },
];

const CONSUMPTION_LEVEL_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "name" },
  { name: "threshold_amount" },
  { name: "privileges", cast: "jsonb" },
  { name: "sort_order" },
  { name: "enabled" },
  { name: "created_at" },
  { name: "updated_at" },
];

const TIP_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "user_id" },
  { name: "order_id" },
  { name: "order_no" },
  { name: "product_title" },
  { name: "product_cover_url" },
  { name: "companion", cast: "jsonb" },
  { name: "quantity" },
  { name: "payment_status" },
  { name: "created_at" },
];

const ORDER_REVIEW_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "user_id" },
  { name: "order_id" },
  { name: "order_no" },
  { name: "product_id" },
  { name: "spec_id" },
  { name: "product_review", cast: "jsonb" },
  { name: "companion_review", cast: "jsonb" },
  { name: "evidence", cast: "jsonb" },
  { name: "status" },
  { name: "reject_reason" },
  { name: "hide_reason" },
  { name: "reviewed_by" },
  { name: "reviewed_by_name" },
  { name: "reviewed_at" },
  { name: "created_at" },
  { name: "updated_at" },
  { name: "product_title" },
  { name: "product_cover_url" },
  { name: "spec_name" },
  { name: "quantity" },
  { name: "completed_at" },
  { name: "companion", cast: "jsonb" },
  { name: "idempotency_key" },
];

const CONVERSATION_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "order_id" },
  { name: "user_id" },
  { name: "kind" },
  { name: "assignment_key" },
  { name: "assignment_seq" },
  { name: "companion_id" },
  { name: "created_at" },
  { name: "user_last_read_at" },
  { name: "companion_last_read_at" },
];

const MESSAGE_COLUMNS: SeedColumn[] = [
  { name: "id" },
  { name: "conversation_id" },
  { name: "order_id" },
  { name: "user_id" },
  { name: "sender_id" },
  { name: "sender_role" },
  { name: "sender_name" },
  { name: "sender_avatar_url" },
  { name: "body" },
  { name: "created_at" },
  { name: "idempotency_key" },
];

const STAFF_READ_COLUMNS: SeedColumn[] = [
  { name: "order_id" },
  { name: "staff_id" },
  { name: "last_read_at" },
];

/**
 * ⚠️ 订单集合**不能只用 `orderSeed`**：`mockPaymentRepository.createStore()` 装的是
 * `[...orderSeed, ...buildRankingPeriodOrders(seedNow)]`，`mockDispatchRepository` 也是。
 * 少装那一批周期榜订单，两个实现从一开始就不是同一份输入，
 * 「结果一致」这句话就再也证明不了什么——而且**不会报错**，只会让比对跑在更小的集合上。
 *
 * ⚠️ `seedNow` 取自 `getMockSeedNow()`，与 Mock 建仓时用的是同一个进程基准时间。
 * 因此派单的截止时间是**相对这份基准**算出来的：同一次进程里两边一致（这正是 parity 要的），
 * 但**跨进程不保证相同**——`buildDispatchSeed` 的注释已经写明这是有意为之。
 * 这里**不**把它改成绝对时间：那会让预置的等待单在几天后全部超时退款。
 */

/**
 * 写入预置数据。
 *
 * 整体一个事务：要么全部表都拿到完整的种子，要么一张都没写。
 * 半份种子会让「Mock 与 Pg 结果一致」的比对得出一个假结论。
 *
 * ⚠️ **顺序不是风格问题**：外键要求被引用的行先存在。
 * companions → orders → dispatch_records →（coupon_templates → coupon_claims）→
 * notifications / complaints / refund_requests → platform_config。
 *
 * PROD-1E 加入的两组按各自的依赖插进去：
 *
 * - **不依赖订单**的一组（users / admin_accounts / staff_accounts / games /
 *   categories / products / product_specs / announcements / banners / quick_entries /
 *   agreements / companion_applications / user_qualifications /
 *   consumption_levels / tip_records）排在 `companions` 之前，
 *   其中只有目录内部一条链 `games → categories → products → product_specs` 有先后要求；
 * - **依赖订单**的一组（order_reviews / conversations / messages / staff_reads）
 *   排在 `orders` 之后（它们都有指向 `orders` 的外键）。
 *
 * ⚠️ 生产环境直接抛错（`assertSeedAllowed`）。
 */
export async function seedDatabase(executor: PgExecutor): Promise<SeedResult> {
  assertSeedAllowed();
  assertSeedFixtures();
  assertOrderHubFixtures();
  assertPlatformFixtures();

  const seedNow = getMockSeedNow();
  const orders = [...orderSeed, ...buildRankingPeriodOrders(seedNow)];
  const dispatches = buildDispatchSeed(orders, seedNow);

  return executor.withTransaction(async (tx) => ({
    favorites: await seedFavorites(tx),
    suggestions: await seedSuggestions(tx),
    // —— PROD-1E：身份 / 目录 / 运营内容 / 入驻 / 权益。这几张表**互不依赖**订单，
    //    因此排在 orders 之前；它们对外键的依赖只有目录内部的
    //    games → categories → products → product_specs 这一条链。——
    users: await seedRows(tx, "users", USER_COLUMNS, userSeed, (user) => [
      user.id,
      user.displayId,
      user.nickname,
      user.avatarUrl,
      user.bio,
    ]),
    adminAccounts: await seedRows(tx, "admin_accounts", ADMIN_ACCOUNT_COLUMNS, adminSeed, (admin) => [
      admin.id,
      admin.username,
      admin.displayName,
      admin.role,
      admin.enabled,
      admin.lastLoginAt,
    ]),
    staffAccounts: await seedRows(tx, "staff_accounts", STAFF_ACCOUNT_COLUMNS, staffSeed, (staff) => [
      staff.id,
      staff.username,
      staff.displayName,
      staff.avatarUrl,
      staff.role,
      staff.enabled,
      staff.createdAt,
      staff.updatedAt,
      staff.lastLoginAt,
      staff.removedAt,
    ]),
    games: await seedRows(tx, "games", GAME_COLUMNS, gameSeed, (game) => [
      game.id,
      game.name,
      jsonbParam(game.regions),
    ]),
    categories: await seedRows(tx, "categories", CATEGORY_COLUMNS, categorySeed, (category) => [
      category.id,
      category.gameId,
      category.name,
      category.sortOrder,
      category.enabled,
      category.createdAt,
      category.updatedAt,
      category.removedAt,
    ]),
    products: await seedRows(tx, "products", PRODUCT_COLUMNS, productSeed, (product) => [
      product.id,
      product.title,
      product.subtitle,
      product.coverUrl,
      product.gameId,
      product.categoryId,
      jsonbParam(product.tags),
      product.detailText,
      jsonbParam(product.detailImages),
      product.sortOrder,
      product.recommended,
      product.status,
      product.monthlySales,
      product.gameTag,
      product.companionRateBp,
      product.createdAt,
      product.updatedAt,
      product.removedAt,
    ]),
    // ⚠️ 规格在实体里挂在商品上（`product.specs`），在库里是**独立一张表**，
    //    因此要摊平：`product_specs.product_id` 是这一层摊平关系的落点。
    productSpecs: await seedRows(
      tx,
      "product_specs",
      PRODUCT_SPEC_COLUMNS,
      productSeed.flatMap((product) => product.specs.map((spec) => ({ spec, productId: product.id }))),
      (row) => [
        row.spec.id,
        row.productId,
        row.spec.name,
        row.spec.price,
        row.spec.sortOrder,
        row.spec.enabled,
        row.spec.removedAt,
      ],
    ),
    announcements: await seedRows(
      tx,
      "announcements",
      ANNOUNCEMENT_COLUMNS,
      announcementSeed,
      (item) => [
        item.id,
        item.title,
        item.imageUrl,
        item.alt,
        item.enabled,
        item.sortOrder,
        item.createdAt,
        item.updatedAt,
        item.removedAt,
      ],
    ),
    banners: await seedRows(tx, "banners", BANNER_COLUMNS, bannerSeed, (item) => [
      item.id,
      item.title,
      item.imageUrl,
      item.alt,
      item.enabled,
      item.sortOrder,
      item.createdAt,
      item.updatedAt,
      item.removedAt,
    ]),
    quickEntries: await seedRows(
      tx,
      "quick_entries",
      QUICK_ENTRY_COLUMNS,
      quickEntrySeed,
      (item) => [
        item.id,
        item.label,
        item.icon,
        item.path,
        item.enabled,
        item.sortOrder,
        item.createdAt,
        item.updatedAt,
        item.removedAt,
      ],
    ),
    agreements: await seedRows(tx, "agreements", AGREEMENT_COLUMNS, agreementSeed, (item) => [
      item.id,
      item.type,
      item.title,
      jsonbParam(item.sections),
      item.version,
      item.updatedAt,
      item.enabled,
    ]),
    companionApplications: await seedRows(
      tx,
      "companion_applications",
      COMPANION_APPLICATION_COLUMNS,
      companionApplicationSeed,
      (item) => [
        item.id,
        item.applicationNo,
        item.userId,
        item.displayName,
        jsonbParam(item.gameIds),
        jsonbParam(item.regions),
        jsonbParam(item.serviceTags),
        item.experience,
        item.introduction,
        item.contactNote,
        jsonbParam(item.evidence),
        item.status,
        item.submittedAt,
        item.updatedAt,
        item.reviewedAt,
        item.reviewNote,
        // 幂等键写 NULL：`mockCompanionApplicationRepository.createStore()` 的
        // `applicationIdByKey` 是**空的**——预置申请按幂等键查不到。理由同优惠券。
        null,
      ],
    ),
    // ⚠️ **刻意空写**：Mock 的资格 store 建仓即为空（理由见
    //    `mockQualificationRepository.ts`：资格是审计历史，不是运行时判据）。
    //    这里保留这一次调用，是为了让「两边都空」这句 parity 有一个显式的落点——
    //    不然将来有人加了资格预置数据，Pg 侧会安静地少一份。
    userQualifications: await seedRows(tx, "user_qualifications", QUALIFICATION_COLUMNS, [], () => []),
    consumptionLevels: await seedRows(
      tx,
      "consumption_levels",
      CONSUMPTION_LEVEL_COLUMNS,
      levelSeed,
      (level) => [
        level.id,
        level.name,
        level.thresholdAmount,
        jsonbParam(level.privileges),
        level.sortOrder,
        level.enabled,
        level.createdAt,
        level.updatedAt,
      ],
    ),
    tipRecords: await seedRows(tx, "tip_records", TIP_COLUMNS, tipSeed, (tip) => [
      tip.id,
      tip.userId,
      tip.orderId,
      tip.orderNo,
      tip.productTitle,
      tip.productCoverUrl,
      jsonbParam(tip.companion),
      tip.quantity,
      tip.paymentStatus,
      tip.createdAt,
    ]),
    companions: await seedRows(tx, "companions", COMPANION_COLUMNS, companionSeed, (companion) => [
      companion.id,
      companion.userId,
      companion.applicationId,
      companion.removedAt,
      companion.displayName,
      companion.avatarUrl,
      companion.rankLabel,
      companion.intro,
      jsonbParam(companion.gameIds),
      jsonbParam(companion.regions),
      jsonbParam(companion.serviceTags),
      companion.available,
      companion.unavailableReason,
      companion.enabled,
      companion.completedOrderCount,
      companion.tipsCount,
      companion.sortOrder,
    ]),
    orders: await seedRows(tx, "orders", ORDER_COLUMNS, orders, (order) => [
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
      jsonbParam(order.addons),
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
      jsonbParam(order.coupon),
      order.actualCompanionId,
      jsonbParam(order.companion),
      order.complaintWindowMinutesSnapshot,
      order.complaintDeadlineAt,
    ]),
    dispatchRecords: await seedRows(tx, "dispatch_records", DISPATCH_COLUMNS, dispatches, (record) => [
      record.id,
      record.orderId,
      record.state,
      record.exclusiveCompanionId,
      record.exclusiveEnteredAt,
      record.exclusiveDeadlineAt,
      record.exclusiveTimeoutMinutesSnapshot,
      record.publicPoolEnteredAt,
      record.publicDeadlineAt,
      record.publicTimeoutMinutesSnapshot,
      record.acceptedByCompanionId,
      record.acceptedAt,
      record.acceptedVia,
      record.timedOutAt,
      record.createdAt,
      record.updatedAt,
    ]),
    couponTemplates: await seedRows(
      tx,
      "coupon_templates",
      COUPON_TEMPLATE_COLUMNS,
      couponSeed,
      (template) => [
        template.id,
        template.name,
        template.formKey,
        template.formLabel,
        template.valueLabel,
        template.conditionLabel,
        template.validFrom,
        template.validTo,
        template.thresholdAmount,
        template.discountAmount,
        template.enabled,
        template.createdAt,
        template.updatedAt,
      ],
    ),
    couponClaims: await seedRows(tx, "coupon_claims", COUPON_CLAIM_COLUMNS, couponClaimSeed, (claim) => [
      claim.id,
      claim.userId,
      claim.couponId,
      claim.status,
      claim.source,
      claim.claimedAt,
      claim.usedAt,
      claim.grantedByAdminId,
      // ⚠️ 幂等键写 NULL：`mockCouponRepository.createStore()` 只把种子放进
      // `claimIdByCoupon`，`claimIdByKey` 是**空的**。写一个编出来的键，
      // 会让「预置券按幂等键查不到」这条 parity 反过来。
      null,
      jsonbParam(claim.snapshot),
    ]),
    notifications: await seedRows(
      tx,
      "notifications",
      NOTIFICATION_COLUMNS,
      notificationSeed,
      (notification) => [
        notification.id,
        notification.userId,
        notification.kind,
        notification.title,
        notification.summary,
        notification.body,
        notification.createdAt,
        notification.readAt,
        notification.href,
      ],
    ),
    complaints: await seedRows(tx, "complaints", COMPLAINT_COLUMNS, complaintSeed, (complaint) => [
      complaint.id,
      complaint.complaintNo,
      complaint.userId,
      complaint.orderId,
      complaint.orderNo,
      complaint.status,
      complaint.typeKey,
      complaint.typeLabel,
      complaint.description,
      jsonbParam(complaint.evidence),
      complaint.contact,
      // 同上：`complaintIdByKey` 建仓为空
      null,
      complaint.createdAt,
      complaint.updatedAt,
      complaint.processingAt,
      complaint.handledAt,
      complaint.handledById,
      complaint.handledByRole,
      complaint.handledByName,
      complaint.result,
    ]),
    refundRequests: await seedRows(tx, "refund_requests", REFUND_COLUMNS, refundSeed, (refund) => [
      refund.id,
      refund.refundNo,
      refund.userId,
      refund.orderId,
      refund.status,
      refund.amount,
      jsonbParam(refund.decision),
      refund.reasonKey,
      refund.reasonLabel,
      refund.description,
      jsonbParam(refund.evidence),
      // 同上：`refundIdByKey` 建仓为空
      null,
      refund.createdAt,
      refund.updatedAt,
      refund.reviewingAt,
      refund.reviewedAt,
      refund.reviewedBy,
      refund.reviewedByRole,
      refund.reviewedByName,
      refund.reviewNote,
      refund.cancelledAt,
    ]),
    platformConfig: await seedRows(
      tx,
      "platform_config",
      PLATFORM_CONFIG_COLUMNS,
      [platformConfigSeed],
      (config) => [
        1,
        config.exclusivePoolTimeoutMinutes,
        config.publicPoolTimeoutMinutes,
        config.completionAutoApprovalMinutes,
        config.complaintWindowMinutes,
        config.updatedAt,
        config.updatedByAdminId,
      ],
    ),
    // —— PROD-1E：依赖 `orders` 的几张表，必须排在 `orders` **之后** ——
    orderReviews: await seedRows(
      tx,
      "order_reviews",
      ORDER_REVIEW_COLUMNS,
      reviewSeed,
      (review) => [
        review.id,
        review.userId,
        review.orderId,
        review.orderNo,
        review.productId,
        review.specId,
        jsonbParam(review.productReview),
        jsonbParam(review.companionReview),
        jsonbParam(review.evidence),
        review.status,
        review.rejectReason,
        review.hideReason,
        review.reviewedBy,
        review.reviewedByName,
        review.reviewedAt,
        review.createdAt,
        review.updatedAt,
        review.productTitle,
        review.productCoverUrl,
        review.specName,
        review.quantity,
        review.completedAt,
        jsonbParam(review.companion),
        // 同上：`mockReviewRepository.createStore()` 的 `reviewIdByKey` 是空的
        null,
      ],
    ),
    conversations: await seedRows(
      tx,
      "conversations",
      CONVERSATION_COLUMNS,
      conversationSeed,
      (conversation) => [
        conversation.id,
        conversation.orderId,
        conversation.userId,
        conversation.kind,
        conversation.assignmentKey,
        conversation.assignmentSeq,
        conversation.companionId,
        conversation.createdAt,
        conversation.userLastReadAt,
        conversation.companionLastReadAt,
      ],
    ),
    messages: await seedRows(tx, "messages", MESSAGE_COLUMNS, messageSeed, (message) => [
      message.id,
      message.conversationId,
      message.orderId,
      message.userId,
      message.senderId,
      message.senderRole,
      message.senderName,
      message.senderAvatarUrl,
      message.body,
      message.createdAt,
      // 同上：`mockMessageRepository.createStore()` 的 `messageIdByKey` 是空的
      null,
    ]),
    staffReads: await seedRows(tx, "staff_reads", STAFF_READ_COLUMNS, staffReadSeed, (record) => [
      record.orderId,
      record.staffId,
      record.lastReadAt,
    ]),
  }));
}
