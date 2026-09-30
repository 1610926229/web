import { ApiError } from "@/lib/api/ApiError";
import { isComputableCouponForm, toCouponSnapshot } from "@/lib/constants/coupons";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getCouponRepository } from "@/lib/data/couponRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminCouponGrantOption,
  AdminCouponGrantResult,
  AdminGrantTargetUser,
  Coupon,
} from "@/lib/types/coupon";

/**
 * 管理端发券服务 —— **向指定用户发放优惠券**（P1-4 验收整改轮 §四 ~ §七）。
 *
 * ## 它刻意只做三件事
 *
 * | 能力 | 出口 |
 * |---|---|
 * | 列出**可发放**的券模板 | `listCouponGrantOptions()` |
 * | 按关键词找用户 | `searchGrantTargetUsers()` |
 * | 发放 | `grantCouponToUser()` |
 *
 * 「查看已发出的券」「撤销发放」**都没有**：裁定 §六 明文「不要建立复杂营销 Ledger」，
 * 而这两件事一旦要做，就必须有一张独立于 `CouponClaim` 的发放台账。需要的只是
 * 「谁发的」这一条最小审计，它挂在 Claim 自己的 `grantedByAdminId` 上。
 *
 * ## 为什么**不**新建一套优惠券系统
 *
 * 发放写的就是普通的 `CouponClaim`（`source: "admin_grant"`），与用户自己领的
 * 落在同一个 Map、走同一个 `lib/data/mockCouponRepository.ts`。因此：
 *
 * - 用户端「我的优惠券」**不需要任何同步动作**就能看到它（同一份数据）；
 * - checkout 的选择链**一行都不用改**就能选它（依旧是按 `claimId` 找 Claim）；
 * - 核销仍然是那一个 `redeemCouponClaimForOrder()`。
 *
 * 换句话说，发放只是「以另一种来源**产生**一张 Claim」，此后它与自己领的券
 * 走完全相同的生命周期。
 */

/** 找不到券模板。与「券不属于当前用户」同一套做法：对外不区分「不存在」与「不可见」。 */
const COUPON_NOT_FOUND_MESSAGE = "优惠券不存在";

/** 发放时选了未启用的模板。 */
const GRANT_DISABLED_TEMPLATE_MESSAGE = "该优惠券已停用，不能发放";

/**
 * 发放时选了非满减券（P1-6 §7）。
 *
 * ⚠️ 这句话与「已停用」**必须分开**：两者的补救动作完全不同——
 * 停用可以去后台重新启用，而折扣券与无门槛券**永远**不会参与结算
 * （P1-4 裁定 §1），发出去也核销不了，只能换一张券发。
 * 合成一句「不能发放」会让管理员去后台找一个并不存在的开关。
 */
const GRANT_UNSUPPORTED_TEMPLATE_MESSAGE = "该优惠券类型不参与结算，不能发放";

/** 发放目标用户不存在。 */
const GRANT_USER_NOT_FOUND_MESSAGE = "用户不存在";

/** 请求体里必须给出的两个业务字段。 */
const GRANT_FIELDS_MISSING_MESSAGE = "缺少 userId 或 couponId";

/** 关键词搜索的最少字符数与返回上限。 */
const TARGET_KEYWORD_MIN_LENGTH = 1;
const TARGET_RESULT_LIMIT = 20;

/**
 * 可发放的券模板：**当前 `enabled` 且参与结算**的（裁定 §四.2 + P1-6 §7）。
 *
 * ⚠️ P1-6 §7 收窄了这里的口径：原文只说「选择 enabled Coupon 模板」，
 * 而 P1-6 起后台能新建券了，于是「enabled 的折扣券」成了一个真实存在的选项——
 * 它 claim 得了、却永远核销不了（`isComputableCouponForm` 是那个判据）。
 * 让管理员发出去一张废纸不是「多给一个选择」，因此在**服务端**筛掉，
 * 而不是靠页面上的下拉框少显示一项。
 *
 * ⚠️ 这里**仍然不**顺手把过期的也筛掉：有效期由 `withinValidity` **显示**给管理员看
 * （发出去一张过期的券是废的，但他有权知道自己正在这么做），而不是替他挡掉——
 * 多一条他没要求的硬规则，将来想发一张「明天开始」的券时会变成拦路石。
 */
export async function listCouponGrantOptions(
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCouponGrantOption[]> {
  const repository = getCouponRepository();
  const now = Date.now();

  // 券模板总量很小（种子 6 张），因此直接取一页足够大的；分页在这里没有意义
  const page = await withMockDebug(params, surface, () =>
    repository.queryCoupons({ userId: "", page: 1, pageSize: 200 }),
  );

  return page.items
    .filter((coupon) => coupon.enabled && isComputableCouponForm(coupon.formKey))
    .map((coupon) => toGrantOption(coupon, now));
}

/**
 * 按关键词找发放目标。
 *
 * 匹配 `id` / `displayId` / 昵称三处：管理员手里的线索可能是其中任何一个
 * （用户报的 ID、后台列表里的昵称）。空关键词返回**空列表**而不是全部——
 * 「不带筛选地拉全量用户」不该是一个顺手可得的操作。
 *
 * ⚠️ 返回值里带上 `ownedCount`：同一个人可能已经领过、甚至被发过好几张，
 * 而裁定 §五 允许重复发放。让管理员**看得见**已有的张数，比在服务端替他挡住更有用。
 */
export async function searchGrantTargetUsers(
  keyword: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminGrantTargetUser[]> {
  const trimmed = keyword.trim();
  if (trimmed.length < TARGET_KEYWORD_MIN_LENGTH) return [];

  const userRepository = getUserRepository();
  const couponRepository = getCouponRepository();

  const users = await withMockDebug(params, surface, () => userRepository.listUsers());
  const lowered = trimmed.toLowerCase();
  const matched = users
    .filter(
      (user) =>
        user.id.toLowerCase().includes(lowered) ||
        user.displayId.toLowerCase().includes(lowered) ||
        user.nickname.toLowerCase().includes(lowered),
    )
    .slice(0, TARGET_RESULT_LIMIT);

  const result: AdminGrantTargetUser[] = [];
  for (const user of matched) {
    // ⚠️ 数的是**这个用户手上的全部 Claim**，不分来源：管理员关心的是
    // 「他手里已经有多少张」，而不是「其中几张是发的」
    const page = await withMockDebug(params, surface, () =>
      // pageSize 取 1 只是不要那 20 条数据，要的是 `total`
      couponRepository.queryOwnedCoupons({ userId: user.id, page: 1, pageSize: 1 }),
    );
    result.push({
      id: user.id,
      displayId: user.displayId,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      ownedCount: page.total,
    });
  }

  return result;
}

/**
 * 向指定用户发放一张券（裁定 §四 / §五 / §七）。
 *
 * ## 顺序
 *
 * 1. **幂等键**：没有就是 400。与其他写接口同一套（`lib/constants/writes.ts`）；
 * 2. 券模板必须存在、**当前启用**且**参与结算**（裁定 §四.2 + P1-6 §7）。
 *    停用的一律拒绝——发出去也核销不了，那是给用户一张废纸；
 * 3. 目标用户必须存在；
 * 4. 写入 Claim：`source: "admin_grant"`、`grantedByAdminId` 记下发放人、
 *    `snapshot` 取**当前模板**（§七：模板后改不追溯这张券）。
 *
 * ## 与「用户自己领」的关系（裁定 §五）
 *
 * **完全独立**。本函数：
 *
 * - 不查「这个用户是不是已经领过这张模板」——可以对已领过、已用过的用户再发；
 * - 不写「一人一券」索引（见 `couponRepository.createGrant` 的说明）；
 * - 因此同一模板可以发出**任意多张**，每张一个独立 `claimId`，
 *   各自的 `unused → used` 互不影响。
 *
 * 这正是 checkout 必须按 `couponClaimId` 而不是 `couponId` 识别券的原因：
 * 同一个 `couponId` 在一个用户手上可能对应好几张 Claim。
 *
 * @param adminId 发放人。**只允许**来自 `requireAdmin()` 返回的会话身份
 */
export async function grantCouponToUser(
  adminId: string,
  body: Record<string, unknown>,
  surface: MockSurface,
  params?: URLSearchParams,
  now: Date = new Date(),
): Promise<AdminCouponGrantResult> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const userId = readRequiredId(body.userId);
  const couponId = readRequiredId(body.couponId);
  if (!userId || !couponId) throw new ApiError("BAD_REQUEST", GRANT_FIELDS_MISSING_MESSAGE);

  const couponRepository = getCouponRepository();
  const userRepository = getUserRepository();

  const coupon = await withMockDebug(params, surface, () => couponRepository.findCouponById(couponId));
  if (!coupon) throw new ApiError("NOT_FOUND", COUPON_NOT_FOUND_MESSAGE);
  if (!coupon.enabled) throw new ApiError("BAD_REQUEST", GRANT_DISABLED_TEMPLATE_MESSAGE);
  // 形态的判定与启用的判定分开（P1-6 §7）：两者的补救动作不同，见上面那句注释
  if (!isComputableCouponForm(coupon.formKey)) {
    throw new ApiError("BAD_REQUEST", GRANT_UNSUPPORTED_TEMPLATE_MESSAGE);
  }

  const user = await withMockDebug(params, surface, () => userRepository.findUserById(userId));
  if (!user) throw new ApiError("NOT_FOUND", GRANT_USER_NOT_FOUND_MESSAGE);

  const result = await couponRepository.createGrant(
    {
      id: `claim_${crypto.randomUUID()}`,
      userId: user.id,
      couponId: coupon.id,
      // 新发的券一定是「未使用」；「已过期」是按时间推出来的展示状态
      status: "unused",
      source: "admin_grant",
      // 发放时刻由服务端写
      claimedAt: now.toISOString(),
      usedAt: null,
      // 最小审计：谁发的。它与 source 互为充要条件（`admin_grant` ⇔ 非 null）
      grantedByAdminId: adminId,
      snapshot: toCouponSnapshot(coupon),
    },
    idempotencyKey,
  );

  return {
    claimId: result.claim.id,
    couponId: coupon.id,
    userId: user.id,
    created: result.created,
  };
}

/** 券模板 → 管理端发放选项。 */
function toGrantOption(coupon: Coupon, now: number): AdminCouponGrantOption {
  const from = Date.parse(coupon.validFrom);
  const to = Date.parse(coupon.validTo);
  return {
    id: coupon.id,
    name: coupon.name,
    formLabel: coupon.formLabel,
    valueLabel: coupon.valueLabel,
    conditionLabel: coupon.conditionLabel,
    validFrom: coupon.validFrom,
    validTo: coupon.validTo,
    // 与 `isExpiredAt` 同一口径：解析不出来按「不在有效期内」处理（fail-closed 的是显示，
    // 不是发放——真正的门槛在 checkout 那道）
    withinValidity:
      Number.isFinite(from) && Number.isFinite(to) && now >= from && now <= to,
  };
}

/**
 * 读一个**必填的 id 字符串**。
 *
 * 与其他写接口同一套做法：请求体是 `unknown`，只按白名单取自己要的字段，
 * 类型不对一律当作没给——不做 `String(value)` 这种把 `{}` 变成 `"[object Object]"` 的转换。
 */
function readRequiredId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
