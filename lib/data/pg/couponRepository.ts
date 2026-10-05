import type { PageResult } from "@/lib/types/common";
import type {
  Coupon,
  CouponClaim,
  CouponClaimSource,
  CouponClaimStatus,
  CouponFormKey,
  CouponSnapshot,
} from "@/lib/types/coupon";
import type { CouponListQuery, CouponRepository } from "../couponRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `CouponRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/couponRepository.ts` 里的接口一个字没改，
 * 服务层 `lib/services/coupons.ts` / `lib/services/adminCoupons.ts` 不知道底下换了存储。
 *
 * ## 这一版真正要消灭的东西：SELECT-then-INSERT
 *
 * `mockCouponRepository.createClaim` 的防重是「先读两个索引、没有再写」：
 *
 *     const existingId = current.claimIdByCoupon.get(businessKey);
 *     if (existingId) { ... return { created: false } }
 *     const byRequest = current.claimIdByKey.get(requestKey);
 *     if (byRequest) { ... return { created: false } }
 *     current.claims.set(claim.id, claim); ...
 *
 * 在「单线程 + 区段内没有 await」的前提下这是原子的。换成数据库后同样的写法
 * （先 `SELECT` 判断、没有再 `INSERT`）会在两个并发请求之间留出空档：
 * 两边都读到「没有」，然后都去写。**判重的职责必须从应用层搬到唯一索引上**，
 * 因此这里全部用单条 `INSERT … ON CONFLICT … DO NOTHING RETURNING`，
 * 冲突时回读索引替我们选定并保住的那一行。
 *
 * ## 「一人一券」是**部分**唯一索引，不是表级 UNIQUE
 *
 * `db/migrations/0007_coupon.sql` 把「用户 + 券」写成：
 *
 *     CREATE UNIQUE INDEX coupon_claims_self_claim_key
 *       ON coupon_claims (user_id, coupon_id) WHERE source = 'self_claim';
 *
 * 因此 `createClaim` 与 `createGrant` 两条写入路径**受不同的约束**（见接口注释里的表）：
 * 管理员发放不受「一人一券」约束，是因为那一行 `source = 'admin_grant'`，压根不进这个索引。
 *
 * ⚠️ 关于 `ON CONFLICT` 的写法，见下面 `createClaim` 里的说明——
 * 索引推断必须是 `ON CONFLICT (user_id, coupon_id) WHERE source = 'self_claim'`，
 * 而本方法因为**还要同时仲裁幂等键索引**，用的是不带冲突目标的 `DO NOTHING`。
 *
 * ## 时间与 JSON
 *
 * `claimed_at` / `used_at` / `valid_from` / `valid_to` 都是 `timestamptz`，
 * 经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串（或 null），因此
 * `CouponClaim.claimedAt` 仍是 `string`，Mock 里 `compareClaimsNewestFirst`
 * 那套字典序比较原样成立。**本文件不出现任何 `new Date(...)`。**
 *
 * `snapshot` 是 `jsonb`，驱动直接解析成 JS 对象，映射时**直接赋值**，不做 `JSON.parse`。
 *
 * ## `expired` 不落库
 *
 * 「已过期」是按当前时间**推导**出来的展示状态（`couponDisplayStatus`），
 * 不是 `coupon_claims.status` 的一个取值——后者只有 `unused` / `used`。
 * 因此本文件里不存在、也不能写「把过期券改成 expired」这类语句。
 */

type CouponTemplateRow = {
  id: string;
  name: string;
  form_key: CouponFormKey;
  form_label: string;
  value_label: string;
  condition_label: string;
  valid_from: string;
  valid_to: string;
  // 非满减券为 NULL：null 表示「没有可计算的门槛」，而不是「门槛为 0」
  threshold_amount: number | null;
  discount_amount: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type CouponClaimRow = {
  id: string;
  user_id: string;
  coupon_id: string;
  status: CouponClaimStatus;
  source: CouponClaimSource;
  claimed_at: string;
  used_at: string | null;
  granted_by_admin_id: string | null;
  // jsonb：驱动已解析成 JS 值，映射时直接赋值
  snapshot: CouponSnapshot;
  // 幂等键**不是实体字段**，只是唯一索引的载体；映射后不进 `CouponClaim`
  idempotency_key: string | null;
};

const COUPON_COLUMNS =
  "id, name, form_key, form_label, value_label, condition_label, valid_from, valid_to, threshold_amount, discount_amount, enabled, created_at, updated_at";

const CLAIM_COLUMNS =
  "id, user_id, coupon_id, status, source, claimed_at, used_at, granted_by_admin_id, snapshot, idempotency_key";

const CLAIM_INSERT_COLUMNS =
  "id, user_id, coupon_id, status, source, claimed_at, used_at, granted_by_admin_id, snapshot, idempotency_key";

function toCoupon(row: CouponTemplateRow): Coupon {
  return {
    id: row.id,
    name: row.name,
    formKey: row.form_key,
    formLabel: row.form_label,
    valueLabel: row.value_label,
    conditionLabel: row.condition_label,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    thresholdAmount: row.threshold_amount,
    discountAmount: row.discount_amount,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `idempotency_key` 是索引载体而不是实体字段，因此**刻意不映射**到 `CouponClaim`。 */
function toCouponClaim(row: CouponClaimRow): CouponClaim {
  return {
    id: row.id,
    userId: row.user_id,
    couponId: row.coupon_id,
    status: row.status,
    source: row.source,
    claimedAt: row.claimed_at,
    usedAt: row.used_at,
    grantedByAdminId: row.granted_by_admin_id,
    snapshot: row.snapshot,
  };
}

/** 一行 `coupon_claims` 的写入值。`snapshot` 走 jsonb：序列化后交给驱动。 */
function claimInsertValues(claim: CouponClaim, idempotencyKey: string | null): unknown[] {
  return [
    claim.id,
    claim.userId,
    claim.couponId,
    claim.status,
    claim.source,
    claim.claimedAt,
    claim.usedAt,
    claim.grantedByAdminId,
    JSON.stringify(claim.snapshot),
    idempotencyKey,
  ];
}

/**
 * 管理员发放的幂等键值。
 *
 * Mock 里发放写的是 `claimIdByKey` 的 `${userId}:grant:${adminId}:${idempotencyKey}`，
 * 而 PG 的唯一索引是 `(user_id, idempotency_key)`——`userId` 已经由列本身承载，
 * 所以**命名空间前缀移进列值**：`grant:<adminId>:<key>`。
 *
 * 于是「同一个管理员重复提交同一份表单只发一张」与「不同管理员各自的发放意图
 * 不互相顶掉」两条语义与 Mock 完全一致；`adminId` 为空时照抄 Mock 的 `"unknown"`。
 */
function grantIdempotencyKeyValue(
  grantedByAdminId: string | null,
  idempotencyKey: string,
): string {
  return `grant:${grantedByAdminId ?? "unknown"}:${idempotencyKey}`;
}

/**
 * 用任意可执行 SQL 的对象造一个优惠券仓储。
 *
 * 与收藏 / 反馈同构：**一个工厂同时产出普通仓储与事务内仓储**——
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让领券 / 核销与同一事务里的
 * 其它写入（订单、派单）共享同一条连接、同一个提交点。接口完全相同，
 * 调用方不需要换一套 API。
 */
export function createCouponRepository(db: PgQueryable): CouponRepository {
  async function countOwnedCoupons(userId: string): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM coupon_claims WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.total ?? 0;
  }

  async function countCoupons(): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM coupon_templates`,
    );
    return rows[0]?.total ?? 0;
  }

  return {
    async queryOwnedCoupons({ userId, page, pageSize }: CouponListQuery): Promise<PageResult<CouponClaim>> {
      const start = (page - 1) * pageSize;

      // total 与当前页在**同一条语句**里取（窗口函数），因此它们看到的是同一个快照——
      // 分两条语句查 count 与列表，中间被并发领取插一脚，hasMore 就会算错。
      // 排序照抄 `compareClaimsNewestFirst`：领取时间倒序，`id` 倒序兜底
      // （时间相同的两条记录不能靠 SQL 的任意顺序决定谁在前面）。
      const rows = await db.query<CouponClaimRow & { total: number }>(
        `SELECT ${CLAIM_COLUMNS}, (count(*) OVER ())::int AS total
           FROM coupon_claims
          WHERE user_id = $1
          ORDER BY claimed_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [userId, pageSize, start],
      );

      // 翻到超出末页时窗口函数没有行可依附，拿不到 total：
      // 这种情况只发生在越界页，补一次计数即可（`page === 1` 时空结果就是 total = 0）
      const total = rows.length > 0 ? rows[0].total : page > 1 ? await countOwnedCoupons(userId) : 0;
      const items = rows.map(toCouponClaim);

      return {
        items,
        page,
        pageSize,
        total,
        // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
        hasMore: start + items.length < total,
      };
    },

    async queryCoupons({ page, pageSize }: CouponListQuery): Promise<PageResult<Coupon>> {
      // 券模板与用户无关（任何人都能看到同一批券），因此这里**不使用** `query.userId`，
      // 「我领过没有」由服务层逐条比对领取记录得出——与 Mock 一致。
      const start = (page - 1) * pageSize;

      // 排序照抄 `compareCouponsNewestFirst`：有效期晚的在前，其次按 id 倒序兜底
      const rows = await db.query<CouponTemplateRow & { total: number }>(
        `SELECT ${COUPON_COLUMNS}, (count(*) OVER ())::int AS total
           FROM coupon_templates
          ORDER BY valid_to DESC, id DESC
          LIMIT $1 OFFSET $2`,
        [pageSize, start],
      );

      const total = rows.length > 0 ? rows[0].total : page > 1 ? await countCoupons() : 0;
      const items = rows.map(toCoupon);

      return {
        items,
        page,
        pageSize,
        total,
        hasMore: start + items.length < total,
      };
    },

    countOwnedCoupons,

    async findCouponById(id) {
      const rows = await db.query<CouponTemplateRow>(
        `SELECT ${COUPON_COLUMNS} FROM coupon_templates WHERE id = $1`,
        [id],
      );
      return rows[0] ? toCoupon(rows[0]) : null;
    },

    /**
     * 按「用户 + 券」查 self-claim 领取记录。
     *
     * ⚠️ `source = 'self_claim'` 不是多此一举：Mock 的 `claimIdByCoupon` 索引
     * 由 `createClaim` 与建仓时的种子写入，两者都是自己领的；
     * 管理员发放走 `createGrant`，**刻意不写**这个索引。
     * 这里加上 `source` 条件，正是那个「不写」在关系模型里的等价表达。
     */
    async findClaim(userId, couponId) {
      const rows = await db.query<CouponClaimRow>(
        `SELECT ${CLAIM_COLUMNS}
           FROM coupon_claims
          WHERE user_id = $1 AND coupon_id = $2 AND source = 'self_claim'`,
        [userId, couponId],
      );
      return rows[0] ? toCouponClaim(rows[0]) : null;
    },

    /**
     * 按「用户 + 领取记录 id」查一条领取记录。
     *
     * `userId` 是**查询条件**而不是事后校验：「查不到」与「不是这个人的」
     * 在本层合成同一个结果，上层就没有可漏的地方。
     */
    async findClaimById(userId, claimId) {
      const rows = await db.query<CouponClaimRow>(
        `SELECT ${CLAIM_COLUMNS} FROM coupon_claims WHERE id = $1 AND user_id = $2`,
        [claimId, userId],
      );
      return rows[0] ? toCouponClaim(rows[0]) : null;
    },

    /**
     * 幂等创建**自己领取**的记录。
     *
     * ## 为什么这里用不带冲突目标的 `ON CONFLICT DO NOTHING`
     *
     * `coupon_claims` 上有**两条**唯一索引参与本次判重：
     *
     * | 索引 | 对应 Mock 的哪一步 |
     * |---|---|
     * | `coupon_claims_self_claim_key`（`(user_id, coupon_id) WHERE source = 'self_claim'`，**部分**索引） | ① 业务唯一键「一人一券」 |
     * | `coupon_claims_idempotency_key`（`(user_id, idempotency_key)`） | ② 通用幂等键 |
     *
     * 想命中**部分**索引，索引推断必须连同谓词一起写：
     *
     *     ON CONFLICT (user_id, coupon_id) WHERE source = 'self_claim' DO NOTHING
     *
     * 这个语法**是对的**（谓词与索引定义逐字一致即可）。但它**只能**仲裁这一条索引；
     * 一旦冲突发生在幂等键索引上，PostgreSQL 会抛 `23505` 而不是 `DO NOTHING`——
     * 那就与 Mock（「同一个幂等键换了张券重放」应当**返回已有记录**，而不是报错）分叉了。
     *
     * 一次 `INSERT` 只能指定一个冲突目标，因此这里用**不带目标**的
     * `ON CONFLICT DO NOTHING`：任何唯一索引冲突都走 `DO NOTHING`，
     * 再由下面的回读区分「命中哪一条约束」，顺序与 Mock 的检查顺序**逐条一致**。
     */
    async createClaim(claim, idempotencyKey) {
      // 最多两轮。第二轮只在「冲突命中后、读回之前，那行被并发删掉」时才会发生。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<CouponClaimRow>(
          `INSERT INTO coupon_claims (${CLAIM_INSERT_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING
           RETURNING ${CLAIM_COLUMNS}`,
          // 自己领的幂等键直接落列：user_id 已由列承载，不需要再拼前缀
          claimInsertValues(claim, idempotencyKey),
        );
        if (inserted[0]) return { claim: toCouponClaim(inserted[0]), created: true };

        // ① 业务唯一键「一人一券」（部分唯一索引 coupon_claims_self_claim_key）。
        //    先查它，与 Mock 的检查顺序一致：两条索引各有一行时，返回业务键那一条。
        const byBusiness = await db.query<CouponClaimRow>(
          `SELECT ${CLAIM_COLUMNS}
             FROM coupon_claims
            WHERE user_id = $1 AND coupon_id = $2 AND source = 'self_claim'`,
          [claim.userId, claim.couponId],
        );
        if (byBusiness[0]) return { claim: toCouponClaim(byBusiness[0]), created: false };

        // ② 幂等键：同一次领取意图重复到达时返回上一次的结果
        const byRequest = await db.query<CouponClaimRow>(
          `SELECT ${CLAIM_COLUMNS}
             FROM coupon_claims
            WHERE user_id = $1 AND idempotency_key = $2`,
          [claim.userId, idempotencyKey],
        );
        if (byRequest[0]) return { claim: toCouponClaim(byRequest[0]), created: false };

        // 走到这里说明冲突的两行都在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `领取记录写入在并发下未能收敛（用户 ${claim.userId} / 券 ${claim.couponId}）。`,
      );
    },

    /**
     * 幂等创建**管理员发放**的记录（P1-4 验收整改轮 §五）。
     *
     * 与 `createClaim` 的两处差别见接口上的说明，在 SQL 侧各自有一一对应的落点：
     *
     * 1. **不仲裁「一人一券」**：发放的行 `source = 'admin_grant'`，
     *    不进 `coupon_claims_self_claim_key` 这个部分索引，因此这里可以放心地
     *    把冲突目标写成幂等键索引——它是本次唯一需要 `DO NOTHING` 的约束。
     *    同时这也意味着「给已领过的用户再发一张」不会被索引拦下，那是明文允许的业务。
     * 2. **幂等键带 adminId 前缀**（见 `grantIdempotencyKeyValue`）：
     *    不同管理员各自的发放意图互不顶掉——与 Mock 的 `grant:${adminId}:` 命名空间等价。
     */
    async createGrant(claim, idempotencyKey) {
      const requestKey = grantIdempotencyKeyValue(claim.grantedByAdminId, idempotencyKey);

      // 最多两轮，理由同 createClaim
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<CouponClaimRow>(
          `INSERT INTO coupon_claims (${CLAIM_INSERT_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (user_id, idempotency_key) DO NOTHING
           RETURNING ${CLAIM_COLUMNS}`,
          claimInsertValues(claim, requestKey),
        );
        if (inserted[0]) return { claim: toCouponClaim(inserted[0]), created: true };

        const existing = await db.query<CouponClaimRow>(
          `SELECT ${CLAIM_COLUMNS}
             FROM coupon_claims
            WHERE user_id = $1 AND idempotency_key = $2`,
          [claim.userId, requestKey],
        );
        if (existing[0]) return { claim: toCouponClaim(existing[0]), created: false };

        // 既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `券发放写入在并发下未能收敛（用户 ${claim.userId} / 券 ${claim.couponId}）。`,
      );
    },

    /**
     * 全部券模板（含已停用）。
     *
     * ⚠️ Mock 返回的是 `Map` 的**插入顺序**，SQL 里没有这个东西可复现。
     * 契约本身**不承诺顺序**（排序与筛选是展示规则，服务层 `compareCouponTemplatesForAdmin`
     * 会重新排），因此这里只做一件事：给一个**完全确定**的顺序，
     * 免得同一份数据两次查询给出两种排列。以「建档时间升序 + id」近似插入顺序。
     */
    async listCouponTemplates() {
      const rows = await db.query<CouponTemplateRow>(
        `SELECT ${COUPON_COLUMNS} FROM coupon_templates ORDER BY created_at ASC, id ASC`,
      );
      return rows.map(toCoupon);
    },

    /**
     * 一个模板被领走 / 发出多少张。
     *
     * 数的是 **Claim 条数**（自己领的 + 管理员发的），与「服务过几个人」不是一回事：
     * 管理员可以对同一个人重复发放，因此 N 张券可能只属于 1 个人。
     */
    async countClaimsByCoupon(couponId) {
      const rows = await db.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM coupon_claims WHERE coupon_id = $1`,
        [couponId],
      );
      return rows[0]?.total ?? 0;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgCouponRepository: CouponRepository = createCouponRepository(lazyPgExecutor());
