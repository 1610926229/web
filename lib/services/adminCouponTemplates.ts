import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_COUPON_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_COUPON_NOT_EDITABLE_MESSAGE,
  ADMIN_COUPON_NOT_FOUND_MESSAGE,
  ADMIN_COUPON_OPERATION_CONFLICT_MESSAGE,
  ADMIN_COUPON_PROFILE_INVALID_MESSAGE,
  ADMIN_COUPON_TEMPLATE_NOTICE,
  buildCouponTemplateListQuery,
  compareCouponTemplatesForAdmin,
  countAdminCouponTemplateStates,
  couponTemplateFieldErrors,
  hasCouponTemplateError,
  matchesCouponTemplateKeyword,
  normalizeCouponTemplatePatch,
  readAdminCouponEnabledFilter,
  toAdminCouponTemplateItem,
  toAdminCouponTemplateWriteResult,
  type CouponTemplateDraft,
  type CouponTemplateListQuery,
} from "@/lib/constants/adminCoupons";
import { ADMIN_ENABLED_INVALID_MESSAGE } from "@/lib/constants/adminCatalog";
import { IDEMPOTENCY_KEY_PATTERN, readBoolean, readIdempotencyKey, readInteger, readTrimmedString } from "@/lib/constants/writes";
import { getCouponRepository } from "@/lib/data/couponRepository";
import {
  createCouponTemplate,
  setCouponTemplateEnabled,
  updateCouponTemplate,
  type AdminCouponTemplateWriteFailure,
  type AdminCouponTemplateWriteOutcome,
  type AdminWriteContext,
} from "@/lib/data/couponTemplateTransaction";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminCouponTemplateItem,
  AdminCouponTemplateListData,
  AdminCouponTemplateWriteResult,
} from "@/lib/types/coupon";

/**
 * 管理端「优惠券模板管理」服务 —— 列表、详情与三种写操作的唯一入口（P1-6）。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处。
 *
 * 这一层负责三件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段就是 `AdminCouponTemplateProfilePatch` 那些）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 生成 DTO —— 仓储实体不会流到浏览器。
 *
 * 业务规则不在这里：字段规则、金额换算、文案派生在 `lib/constants/adminCoupons.ts`；
 * **「形态能不能编辑」的最终判定**在 `lib/data/couponTemplateTransaction.ts` 的原子区段里
 * ——它要读当前记录的 `formKey`，而服务层手上那份可能已经过期。
 *
 * ⚠️ **数据源只有一份**：本文件读的券模板与用户端领券中心读的是同一个仓储
 * （`getCouponRepository()`），因此这里的编辑会立刻反映到前台，不需要任何同步动作。
 *
 * ⚠️ **与 `lib/services/adminCoupons.ts` 的分工**：那一个是**发放**（以另一种来源
 * 产生一张 `CouponClaim`），本文件是**模板本身**的增删改。两者的写入对象不同，
 * 因此没有共用函数——发放不改模板，改模板不发放。
 */

export type { AdminCouponTemplateListData };

/**
 * 解析列表查询条件。约定与其它管理列表一致：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 *
 * ⚠️ 与类目列表不同，这里**不需要**先取一批已知 id 做存在性校验：
 * 券模板的筛选只有「关键词 + 启用状态」，两者都不引用外部集合。
 */
export function resolveCouponTemplateListQuery(
  params: URLSearchParams,
  strict: boolean,
): CouponTemplateListQuery {
  const enabled = readAdminCouponEnabledFilter(params.get("enabled"));
  if (strict && enabled === null) {
    throw new ApiError("BAD_REQUEST", ADMIN_ENABLED_INVALID_MESSAGE, 400);
  }

  return buildCouponTemplateListQuery({ params, enabled: enabled ?? "" });
}

/**
 * 管理端券模板列表。
 *
 * 走的是仓储里**唯一**的那份券模板表（含已停用），因此「后台看到全部、
 * 用户端只看到可领的」这件事由数据层与 `lib/constants/coupons.ts` 保证，
 * 页面不自己过滤。
 *
 * ⚠️ 角标与筛选**用的是同一份全量数据**：`counts` 按**全部**记录算
 * （「已启用 3 / 已停用 2」是导航用的数字），而 `items` 按筛选后的集合分页。
 * 两者若各查一次，页面上就会出现「角标说 5 条、列表只有 2 条」这种自相矛盾。
 */
export async function queryAdminCouponTemplateList(
  query: CouponTemplateListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCouponTemplateListData> {
  return withMockDebug(params, surface, async () => {
    const repository = getCouponRepository();
    const all = await repository.listCouponTemplates();
    const counts = countAdminCouponTemplateStates(all);

    if (mockEmptyApplies(params, "coupons")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        counts,
        notice: ADMIN_COUPON_TEMPLATE_NOTICE,
      };
    }

    const rows = all
      .filter(
        (coupon) =>
          matchesCouponTemplateKeyword(coupon, query.keyword) &&
          (query.enabled === "" ||
            (query.enabled === "enabled" ? coupon.enabled : !coupon.enabled)),
      )
      .sort(compareCouponTemplatesForAdmin);

    const start = (query.page - 1) * query.pageSize;
    const pageRows = rows.slice(start, start + query.pageSize);

    // 每行都要一个「已经被领走多少张」。**串行取会慢一倍**，因此一次并发取回来；
    // 数量就是本页条数（最多 50），不会把仓储压垮
    const claimCounts = await Promise.all(
      pageRows.map((coupon) => repository.countClaimsByCoupon(coupon.id)),
    );

    const items: AdminCouponTemplateItem[] = pageRows.map((coupon, index) =>
      toAdminCouponTemplateItem(coupon, claimCounts[index] ?? 0),
    );

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: rows.length,
      hasMore: start + items.length < rows.length,
      counts,
      notice: ADMIN_COUPON_TEMPLATE_NOTICE,
    };
  });
}

/**
 * 管理端券模板详情。
 *
 * ⚠️ **已停用的模板仍然返回详情**：后台要能查看并重新启用它。
 * 返回 404 等于把「停用」变成了「记录消失」，那正是 §6 不肯做硬删除要避免的事。
 */
export async function getAdminCouponTemplateDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCouponTemplateItem | null> {
  return withMockDebug(params, surface, async () => {
    const repository = getCouponRepository();
    const coupon = await repository.listCouponTemplates().then((all) =>
      all.find((item) => item.id === id) ?? null,
    );

    return coupon
      ? toAdminCouponTemplateItem(coupon, await repository.countClaimsByCoupon(coupon.id))
      : null;
  });
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————

function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_COUPON_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return {
    actorId: adminId,
    actorRole: "admin",
    actorName: null,
    operationId,
    at: new Date().toISOString(),
  };
}

/**
 * 从请求体里读出一份**规范形状**的券模板输入。
 *
 * ⚠️ **入参就是白名单**：`id`、`createdAt`、`updatedAt`、`formKey`、`formLabel`、
 * `valueLabel`、`conditionLabel` 在这里**没有读取的位置**，客户端多传一个字段
 * 也不会有任何效果。这不是「忘了校验」，而是类型上就没有入口
 * （§九：客户端伪造 ID、状态、时间、文案必须被忽略）。
 *
 * ⚠️ 金额缺省用 `NaN` 而不是 0：`NaN` 会让「必须大于 0」的校验报错，
 * 静默当成 0 等于把一个没传的字段变成一个「合法」的值写进记录。
 * 与类目的 `sortOrder` 同一套做法。
 *
 * ⚠️ 时间**不做任何换算**：接口收的就是 ISO 字符串。表单那一侧的
 * 「北京时间墙钟 → ISO」在 `lib/constants/adminCoupons.ts` 里，不在这里。
 */
function readCouponTemplateInput(body: Record<string, unknown>): CouponTemplateDraft {
  return {
    name: readTrimmedString(body, "name"),
    thresholdAmount: readInteger(body, "thresholdAmount", Number.NaN),
    discountAmount: readInteger(body, "discountAmount", Number.NaN),
    validFrom: readTrimmedString(body, "validFrom"),
    validTo: readTrimmedString(body, "validTo"),
    enabled: readBoolean(body, "enabled", true),
  };
}

/**
 * 逐字段校验 → 入参；任何一处不过就抛 400，message 是**第一条**错误。
 *
 * ⚠️ 服务端**自己也判一次**，不假设客户端已经判过：接口是可以被直接请求的，
 * 而「页面上的校验」对一次 `curl` 没有任何约束力。
 *
 * ⚠️ **拒绝，不夹取**：一条 `threshold = -1` 的输入在这里变成 400，
 * 而不是被改成 1 写进去——后者会让一次写错的保存看起来成功（§4）。
 */
function validateCouponTemplate(draft: CouponTemplateDraft): CouponTemplateDraft {
  const errors = couponTemplateFieldErrors(draft);
  if (hasCouponTemplateError(errors)) {
    throw new ApiError("BAD_REQUEST", firstErrorMessage(errors), 400);
  }

  const patch = normalizeCouponTemplatePatch(draft);
  if (!patch) throw new ApiError("BAD_REQUEST", ADMIN_COUPON_PROFILE_INVALID_MESSAGE, 400);
  return patch;
}

function firstErrorMessage(errors: Record<string, string | null>): string {
  for (const message of Object.values(errors)) {
    if (message) return message;
  }
  return ADMIN_COUPON_PROFILE_INVALID_MESSAGE;
}

/**
 * 伪事务的失败 → 接口错误。
 *
 * 三种失败各有各的处置，合并成一句「操作失败」会让调用方不知道该刷新、
 * 该改表单还是该去找另一张券。
 */
function toApiFailure(failure: AdminCouponTemplateWriteFailure): ApiError {
  switch (failure.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_COUPON_NOT_FOUND_MESSAGE, 404);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_COUPON_OPERATION_CONFLICT_MESSAGE, 400);
    case "not-editable":
      // 这句话与列表项上的 `editable: false` **同源**：界面上的「编辑」入口
      // 本来就不会出现在非满减券上，走到这里说明调用方绕过了界面
      return new ApiError("BAD_REQUEST", ADMIN_COUPON_NOT_EDITABLE_MESSAGE, 400);
  }
}

/**
 * 伪事务结果 → 接口结果。
 *
 * ⚠️ 成功时**只回状态字段**（`couponId` / `enabled` / `updatedAt` / `changed`），
 * 不整条回实体：界面据此就地更新那一行，不必为了刷新一个开关重拉整页。
 * 编辑表单要用到的新值由它自己保存后重新取一次详情（与类目详情页同一套做法）。
 */
function toWriteResult(outcome: AdminCouponTemplateWriteOutcome): AdminCouponTemplateWriteResult {
  if (outcome.kind !== "ok") throw toApiFailure(outcome);

  const { updated } = outcome.value;
  return toAdminCouponTemplateWriteResult(updated, outcome.changed);
}

// ——————————————————————————— 三种写操作 ———————————————————————————

/**
 * 新建优惠券模板。
 *
 * ⚠️ 只可能是**满减券**（§1）：请求体里带 `formKey` 不会被读到，
 * `valueLabel` / `conditionLabel` 也不会——它们由服务端按金额派生（§3）。
 */
export async function createAdminCouponTemplate(
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCouponTemplateWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const draft = validateCouponTemplate(readCouponTemplateInput(body));

  return toWriteResult(await createCouponTemplate(draft, writeContext(adminId, operationId)));
}

/**
 * 编辑优惠券模板（名称 / 门槛 / 优惠金额 / 有效期 / 启用状态，一次保存）。
 *
 * 非满减券会被伪事务拒绝（`not-editable`），而**服务层无法预判**这件事——
 * 它要读当前记录的 `formKey`，只有原子区段里那份才是准的。
 */
export async function updateAdminCouponTemplate(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCouponTemplateWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const draft = validateCouponTemplate(readCouponTemplateInput(body));

  return toWriteResult(
    await updateCouponTemplate(id, draft, writeContext(adminId, operationId)),
  );
}

/**
 * 启用 / 停用优惠券模板（窄写入）。
 *
 * ⚠️ 与 `updateAdminCouponTemplate()` 分开：详情页上的开关只应当改启用状态，
 * 而不是「读出整条记录、拼一个完整 patch 再写回去」——后者会在两位管理员
 * 同时操作时，用后写的那次把另一位刚改好的金额覆盖回旧值。
 *
 * ⚠️ 这个开关在**详情页**，不在列表行上：停用会让已经领到券的用户当下不能核销，
 * 值得强制「先看清这张券是什么、已经发出去多少张，再决定动不动它」。
 *
 * ⚠️ **不需要校验任何业务字段**：本操作只带一个 `enabled`，
 * 没有金额、没有有效期、也没有名称可以写错。
 */
export async function setAdminCouponTemplateEnabled(
  id: string,
  enabled: boolean,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCouponTemplateWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(
    await setCouponTemplateEnabled(id, enabled, writeContext(adminId, operationId)),
  );
}
