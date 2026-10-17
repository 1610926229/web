import { compareClaimsNewestFirst, compareCouponsNewestFirst } from "@/lib/constants/coupons";
import { couponClaimSeed, couponSeed } from "@/lib/mocks/fixtures/couponSeed";
import type { Coupon, CouponClaim } from "@/lib/types/coupon";
import type { CouponRepository } from "./couponRepository";
import { getMockStore } from "./mockStore";

/**
 * 优惠券的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置的券与用户新领取的记录进的是**同一个 Map、同一套查询方法**，
 * 「领取后立刻出现在我的优惠券里」正是由这一点保证的。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**。
 */
export type MockCouponStore = {
  coupons: Map<string, Coupon>;
  claims: Map<string, CouponClaim>;
  /** `${userId}:${couponId}` → 领取记录 id（业务唯一键） */
  claimIdByCoupon: Map<string, string>;
  /** `${userId}:${idempotencyKey}` → 领取记录 id（通用幂等索引） */
  claimIdByKey: Map<string, string>;
};

function createStore(): MockCouponStore {
  return {
    coupons: new Map(couponSeed.map((coupon) => [coupon.id, coupon])),
    claims: new Map(couponClaimSeed.map((claim) => [claim.id, claim])),
    claimIdByCoupon: new Map(
      couponClaimSeed.map((claim) => [couponKey(claim.userId, claim.couponId), claim.id]),
    ),
    claimIdByKey: new Map(),
  };
}

function store(): MockCouponStore {
  return getMockStore("coupon", createStore);
}

/**
 * 本存储的句柄（**同步**）。
 *
 * 导出它是为了让券的核销能与「订单 + 派单」写进**同一段无 `await` 的原子区段**
 * （`lib/data/couponRedemptionTransaction.ts` ← `mockPaymentRepository.confirmPaymentRequest`）。
 * 与本仓储的其它方法不同，它没有 `Promise` 包装：一旦改成 `await` 调用，
 * 支付那一段原子区段就会被打断，「一张券被核销两次」就重新变成可能。
 *
 * ⚠️ 关于 `resetMockStore()`：它换掉的是 `globalThis` 上的整份存储，因此**每次都要现取**，
 * 不能在模块顶层缓存一份。这一点与 `paymentStore()` / `dispatchStore()` 相同。
 */
export function couponStore(): MockCouponStore {
  return store();
}

function couponKey(userId: string, couponId: string): string {
  return `${userId}:${couponId}`;
}

/* ────────────── 券模板的同步写入原语（P1-6） ──────────────
 *
 * ⚠️ 它们**只给** `lib/data/couponTemplateTransaction.ts` 的原子区段用。
 * 与 `createClaim` / `createGrant` 不同，这里没有幂等判断、也没有审计——
 * 那两件事属于伪事务，写在下面这些函数里就会与业务写入分开成两步，
 * 而「业务写成功、审计没写进去」是事后无法补救的。
 *
 * ⚠️ 每一个都**只覆盖它该覆盖的字段**：`applyCouponEnabled` 尤其不能退化成
 * `applyCouponPatch(id, { enabled }, at)` 的调用方——详情页上的开关只应当改这一个字段，
 * 走「先读出来、拼一个完整 patch 再写回去」的话，两位管理员同时操作时，
 * 后写的那次会把另一位刚改好的金额覆盖回旧值。
 */

/** 新建一条券模板记录。`id` 由调用方在原子区段内用 `nextRecordId()` 生成。 */
export function createCouponRecord(record: Coupon): Coupon {
  const current = store();

  // —— 原子区段开始（无 await）——
  current.coupons.set(record.id, { ...record });
  // —— 原子区段结束 ——

  return { ...record };
}

/**
 * 编辑券模板。
 *
 * ⚠️ 只覆盖 `patch` 里那些字段：`id`、`formKey`、`formLabel`、`createdAt` 一律原样保留。
 * 「顺手把一张折扣券改成满减券」在 `patch` 类型里没有位置可写——
 * 形态决定了这张券能不能参与结算（§1），要换形态只能新建一张。
 */
export function applyCouponPatch(
  id: string,
  patch: Pick<
    Coupon,
    | "name"
    | "valueLabel"
    | "conditionLabel"
    | "validFrom"
    | "validTo"
    | "enabled"
    | "thresholdAmount"
    | "discountAmount"
  > & { at: string },
): { previous: Coupon; updated: Coupon } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.coupons.get(id);
  if (!existing) return null;

  const { at, ...fields } = patch;
  const updated: Coupon = { ...existing, ...fields, updatedAt: at };
  current.coupons.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}

/**
 * 只改券模板的启用状态。
 *
 * 窄写入器，理由见上面那一段说明：停用只应当改这一个字段。
 */
export function applyCouponEnabled(
  id: string,
  enabled: boolean,
  at: string,
): { previous: Coupon; updated: Coupon } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.coupons.get(id);
  if (!existing) return null;

  const updated: Coupon = { ...existing, enabled, updatedAt: at };
  current.coupons.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}

function idempotencyKeyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

export const mockCouponRepository: CouponRepository = {
  async queryOwnedCoupons(query) {
    const { userId, page, pageSize } = query;

    const filtered = [...store().claims.values()]
      .filter((claim) => claim.userId === userId)
      .sort(compareClaimsNewestFirst);

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: filtered.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  async queryCoupons(query) {
    const { page, pageSize } = query;

    // 券模板与用户无关（任何人都能看到同一批券），因此这里不按 userId 过滤；
    // 「我领过没有」由服务层逐条比对领取记录得出。
    const all = [...store().coupons.values()].sort(compareCouponsNewestFirst);

    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: all.length,
      hasMore: start + items.length < all.length,
    };
  },

  async countOwnedCoupons(userId) {
    return [...store().claims.values()].filter((claim) => claim.userId === userId).length;
  },

  async findCouponById(id) {
    return store().coupons.get(id) ?? null;
  },

  async findClaim(userId, couponId) {
    const id = store().claimIdByCoupon.get(couponKey(userId, couponId));
    return id ? (store().claims.get(id) ?? null) : null;
  },

  async findClaimById(userId, claimId) {
    const claim = store().claims.get(claimId);
    // 「查不到」与「不是这个人的」返回同一个结果：上层不需要（也不该）自己再比一次
    return claim && claim.userId === userId ? claim : null;
  },

  async createClaim(claim, idempotencyKey) {
    const current = store();
    const businessKey = couponKey(claim.userId, claim.couponId);
    const requestKey = idempotencyKeyOf(claim.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    // ① 业务唯一键：同一个人对同一张券只可能有一条记录
    const existingId = current.claimIdByCoupon.get(businessKey);
    if (existingId) {
      const existing = current.claims.get(existingId);
      // 索引命中但记录已不存在属于不可能状态；真出现时按未创建处理，保证不会卡住领取
      if (existing) return { claim: existing, created: false };
    }

    // ② 幂等键：同一次领取意图重复到达时返回上一次的结果
    const byRequest = current.claimIdByKey.get(requestKey);
    if (byRequest) {
      const existing = current.claims.get(byRequest);
      if (existing) return { claim: existing, created: false };
    }

    current.claims.set(claim.id, claim);
    current.claimIdByCoupon.set(businessKey, claim.id);
    current.claimIdByKey.set(requestKey, claim.id);
    // —— 原子区段结束 ——

    return { claim, created: true };
  },

  /**
   * 管理员发放（P1-4 验收整改轮 §五）。与 `createClaim` 的两处差别见接口上的说明：
   * **不写** `claimIdByCoupon`（发放不受「一人一券」约束），
   * 幂等键里带上 `adminId`（不同管理员各自的发放意图互不顶掉）。
   */
  async createGrant(claim, idempotencyKey) {
    const current = store();
    const requestKey = idempotencyKeyOf(
      claim.userId,
      `grant:${claim.grantedByAdminId ?? "unknown"}:${idempotencyKey}`,
    );

    // —— 原子区段开始（无 await）——
    const byRequest = current.claimIdByKey.get(requestKey);
    if (byRequest) {
      const existing = current.claims.get(byRequest);
      if (existing) return { claim: existing, created: false };
    }

    current.claims.set(claim.id, claim);
    current.claimIdByKey.set(requestKey, claim.id);
    // —— 原子区段结束 ——

    return { claim, created: true };
  },

  /**
   * 全部券模板（P1-6）。**含已停用**，且不排序、不分页——
   * 排序与筛选是展示规则，在 `lib/constants/adminCoupons.ts` 里，
   * 而那两件事都需要看到**全部**记录才能算对（角标按全量算）。
   */
  async listCouponTemplates() {
    return [...store().coupons.values()].map((coupon) => ({ ...coupon }));
  },

  /**
   * 一个模板被领走 / 发出多少张（P1-6）。
   *
   * ⚠️ 数的是 **Claim 条数**，与「这个模板一共服务过几个人」不是一回事：
   * 管理员可以对同一个人重复发放（§五），因此 N 张券可能只属于 1 个人。
   * 后台那个数字的用途是「停用会影响多少张券」，张数才是对的量纲。
   */
  async countClaimsByCoupon(couponId) {
    return [...store().claims.values()].filter((claim) => claim.couponId === couponId).length;
  },
};
