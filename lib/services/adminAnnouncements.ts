import { ApiError } from "@/lib/api/ApiError";
import {
  contentImageFieldErrors,
  countAdminContentStates,
  filterContentForAdmin,
  firstContentImageErrorField,
  normalizeAnnouncementProfilePatch,
  resolveContentRemovalFilter,
  type ContentImageInput,
  type ContentRemovalFilter,
} from "@/lib/constants/adminContent";
import { toAdminAnnouncementItem, toAdminAnnouncementList } from "@/lib/constants/homeContent";
import {
  IDEMPOTENCY_KEY_PATTERN,
  readBoolean,
  readIdempotencyKey,
  readInteger,
  readTrimmedString,
} from "@/lib/constants/writes";
import {
  createAnnouncement,
  removeAnnouncement,
  setAnnouncementEnabled,
  updateAnnouncement,
  type AdminContentWriteFailure,
  type AdminWriteContext,
} from "@/lib/data/adminContentTransaction";
import { getContentRepository } from "@/lib/data/contentRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminAnnouncementItem,
  AdminAnnouncementProfilePatch,
  AdminContentList,
} from "@/lib/types/content";

/**
 * 管理端「图片公告」服务 —— 列表、详情与四种写操作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再判一次角色：权限判断只有 `lib/api/adminRoute.ts` 一处。
 *
 * 这一层做三件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段就是 `AdminAnnouncementProfilePatch` 那些）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 生成 DTO —— 仓储实体不会流到浏览器（`removedAt` 原文在响应里没有位置）。
 *
 * 业务规则不在这一层：字段取值与状态口径在 `lib/constants/adminContent.ts`，
 * 「重放还是冲突」「已移除的不许改」在 `lib/data/adminContentTransaction.ts` 的原子区段里
 * ——后者必须与写入同一区间，放在这儿就挡不住并发。
 *
 * ⚠️ **数据源只有一份**：本文件读的公告与首页公告区读的是同一个仓储
 * （`getContentRepository()`），因此这里的编辑会立刻反映到用户端，不需要任何同步动作。
 * 「哪些记录用户端看得见」是 `lib/constants/homeContent.ts` 的纯函数，
 * 服务层不自己过滤一遍——两套过滤口径迟早会分叉。
 */

/**
 * 列表查询条件。
 *
 * ⚠️ 与类目 / 商品列表刻意不同：这里**只有筛选、没有分页**。运营内容是个位数到几十条，
 * 加分页只会制造「改完第 3 页的排序、第 1 页没变」这类由分页自己造出来的问题。
 * 分页条件是分页字段的一部分，因此也一起不存在。
 */
export type AdminContentListQuery = { removal: ContentRemovalFilter };

// —————————————————— 服务级文案（三组内容共用，定义在这里的原因见下） ——————————————————

/**
 * 为什么这几句定义在**服务层**而不是 `lib/constants/adminContent.ts`：
 *
 * 那边放的是**字段级**文案（名称、图片地址、说明、排序各自的报错），与三组内容共用的
 * 字段规则在一起；而「不存在 / 已移除 / 幂等键冲突 / 幂等键缺失」这四句是**服务级**
 * 文案，各模块的同类文案（`ADMIN_CATEGORY_*`、`ADMIN_PRODUCT_*` …）都定义在各自的
 * 常量文件里。本阶段 `lib/constants/adminContent.ts` 里没有它们，而那个文件不由本文件
 * 负责，因此暂放在这里，由 `lib/services/adminBanners.ts` 复用。
 *
 * ⚠️ 复用而不是两边各写一份：同一句话写两遍，迟早会出现「同一件事两种说法」，
 * 而运营正是拿着这两句话去对照着排查的。集成阶段应当把它们搬进
 * `lib/constants/adminContent.ts`（届时两个服务文件都从那里取，调用点不用改）。
 */
export const ADMIN_CONTENT_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";
export const ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_CONTENT_PROFILE_INVALID_MESSAGE = "素材资料校验未通过，请检查表单";
export const ADMIN_CONTENT_REMOVAL_INVALID_MESSAGE = "筛选条件 removal 只能是 active / removed";

/** 公告自己的两句；活动 Banner 有一份同形的（`lib/services/adminBanners.ts`）。 */
export const ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE = "公告不存在";
export const ADMIN_ANNOUNCEMENT_REMOVED_MESSAGE = "该公告已移除，不能再编辑或启停";

/**
 * 写操作的结果（四种写操作共用）。
 *
 * ⚠️ 与 `AdminCategoryWriteResult` / `AdminProductWriteResult` 只差两处，都是刻意的：
 *
 * - **`removed` 而不是 `removedAt`**：与列表项 DTO 同一口径。软删除的**时间**是审计
 *   要回答的问题，不是列表要显示的东西；把它放进响应等于多留一个将来会被前端误用的字段。
 * - **多一个 `replayed`**：那几组写结果只有 `changed`，而 `changed:false` 有两种来源
 *   ——「提交的内容与现状一模一样」与「这个幂等键早就做过了」。客户端要给出的提示完全
 *   不同（「已保存」 vs 「刚才那一次已经生效过了」），一个字段说不清是哪一种。
 *
 * ⚠️ **没有 `action`**。事务层确实算出了那一次变更名（同一个编辑接口既可能记成
 * `update`、也可能记成 `enable` / `disable`），但它**属于审计**，不属于响应体：
 * 「这次到底记成了哪一条」的唯一权威是审计记录本身，把它回给客户端等于让界面
 * 有机会照着响应复述一个它没有验证过的说法。要断言它，去读审计（见
 * `tests/adminContentImages.test.mjs` 同时断言写结果与 `listAudits()`）。
 * 这一条与 `lib/types/catalog.ts` 的 `AdminCategoryWriteResult` 口径一致。
 */
export type AdminAnnouncementWriteResult = {
  announcementId: string;
  enabled: boolean;
  removed: boolean;
  changed: boolean;
  replayed: boolean;
  /**
   * 服务端**确认之后**的那条记录（管理端列表项 DTO，`removedAt` 照旧没有位置）。
   *
   * 有了它，客户端不必为了「写完之后表单该以哪一条为基准」再读一次详情
   * ——再读一次是另一个时刻的数据，两次读之间别人改过的话，表单会以一个
   * 自己没提交过的版本重挂载。它与上面那几行**是同一份快照**，不是第二次读。
   *
   * 重放（`replayed: true`）时它是**第一次**写出来的那条：重放返回的必须是
   * 第一次的结果，否则「同一个键第二次到达」会得到一个与第一次不同的答案。
   */
  updated: AdminAnnouncementItem;
};

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表筛选条件。
 *
 * 严格 / 宽松两种读法与其它管理列表一致：**接口** `strict: true`，非法枚举 400；
 * **页面** `strict: false`，收敛到默认值——地址栏被手改坏了不该让整页报错。
 *
 * ⚠️ 严格这一路是本文件补的：地基只提供宽松版 `resolveContentRemovalFilter()`
 * （非法值静默回落到 `active`）。静默回落用在接口上会让调用方拿着一个
 * 「自己都不知道筛了什么」的结果继续往下走，因此这里显式判一次。
 */
export function resolveAdminContentListQuery(
  params: URLSearchParams,
  strict: boolean,
): AdminContentListQuery {
  const raw = params.get("removal");
  if (strict && !isContentRemovalFilter(raw)) {
    throw new ApiError("BAD_REQUEST", ADMIN_CONTENT_REMOVAL_INVALID_MESSAGE, 400);
  }

  return { removal: resolveContentRemovalFilter(raw) };
}

/** 空值与合法值一并放行：缺省即默认筛选，不算非法。 */
function isContentRemovalFilter(raw: string | null): boolean {
  const value = raw?.trim() ?? "";
  return value === "" || value === "active" || value === "removed";
}

/**
 * 管理端公告列表。
 *
 * 走的是仓储里**唯一**的那份公告表（含停用与已移除），因此「后台看到全部、
 * 用户端只看到启用且未移除的」由数据层与 `lib/constants/homeContent.ts` 保证，
 * 这里不自己过滤一遍。
 *
 * ⚠️ `total` 与 `items.length` **不是一回事**：`total` 始终是「还在用的有多少条」
 * （未移除），筛选 `removal=removed` 时 `items` 装的是已移除的那批。
 * 后台页面上「共 N 条」说的是前者——运营关心的是自己手上还有多少素材。
 */
export async function queryAdminAnnouncementList(
  query: AdminContentListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminContentList<AdminAnnouncementItem>> {
  return withMockDebug(params, surface, async () => {
    const all = await getContentRepository().listAnnouncementRecords();

    // 角标口径覆盖**全部**记录（含已移除）：已移除是素材的一个终态，
    // 但已移除的**不能**混进 enabled / disabled 里——那两个角标点进去看的是还在用的记录
    const counts = countAdminContentStates(all);

    // 空态注入沿用首页的 `announcements` 范围：它指的就是这一组记录。
    // 不为后台另开一个语义相同的枚举值（那是同一个概念的第二份定义），
    // 也不影响首页——首页那次取数是另一次独立调用
    const items = mockEmptyApplies(params, "announcements")
      ? []
      : toAdminAnnouncementList(filterContentForAdmin(all, query.removal));

    return { items, total: counts.all - counts.removed, counts };
  });
}

/**
 * 管理端公告详情。
 *
 * ⚠️ **已移除的公告仍然返回详情**：后台要能查到「这条素材被移除过」，
 * 返回 404 等于把软删除变成了记录消失，那正是软删除要避免的事。
 */
export async function getAdminAnnouncementDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminAnnouncementItem | null> {
  return withMockDebug(params, surface, async () => {
    const record = await getContentRepository().findAnnouncementById(id);
    return record ? toAdminAnnouncementItem(record) : null;
  });
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————

/**
 * 幂等键。缺失或非法一律 400，**在任何数据被读之前**。
 *
 * 客户端用 `crypto.randomUUID()` 生成即可满足这个格式；这里只做基本约束，
 * 真正的防重在事务层的原子区段里（同一个键第二次到达返回第一次的结果）。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_CONTENT_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

/**
 * 写上下文。
 *
 * ⚠️ **身份只有一个来源**：`adminId` 来自 `requireAdmin()` 的会话，
 * `actorRole` 固定 `"admin"`，`actorName` 本阶段一律 `null`（见 `lib/types/adminAudit.ts`）。
 * 请求体里的 `actorId` / `role` / `actorName` 在这里**没有读取的位置**——
 * 不是「校验后被忽略」，而是类型上没有入口（§九）。
 *
 * `at` 在这里取一次，业务写入与审计写入共用同一个值：审计回答的是
 * 「这一刻发生了什么」，两者差几毫秒就会让「先改的还是先记的」说不清。
 */
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
 * 从请求体里读出一份完整的素材输入。
 *
 * ⚠️ **入参就是白名单**：`id`、`createdAt`、`updatedAt`、`removedAt` 在这里没有读取的位置，
 * 客户端多传一个也不会有任何效果。`removedAt` 尤其重要：移除是一条**独立的状态迁移**
 * （有自己的接口与审计动作），不是一个可以随表单提交的字段。
 *
 * `sortOrder` 缺省用 `NaN` 而不是 0：NaN 会让「排序值必须是区间内的整数」报错，
 * 静默当成 0 等于把一个没传的字段变成一个合法值写进记录（与类目同）。
 */
function readImageInput(body: Record<string, unknown>): ContentImageInput {
  return {
    title: readTrimmedString(body, "title"),
    imageUrl: readTrimmedString(body, "imageUrl"),
    alt: readTrimmedString(body, "alt"),
    sortOrder: readInteger(body, "sortOrder", Number.NaN),
    enabled: readBoolean(body, "enabled", true),
  };
}

/**
 * 逐字段校验 → 可写入的 patch。
 *
 * 报的是**第一条**字段错误（按页面上的字段顺序，即最靠上的那一栏），
 * 与表单的字段级错误**同源**：运营看到的就是「名称这一栏错了」，
 * 而不是一条不知道改哪里的横幅。
 *
 * `normalize*()` 再返回 `null` 时说明「逐字段全过、整体却不成立」——
 * 今天不会发生（两边用的是同一套规则），但这条分支必须留着：
 * 它是「校验与写入看到的是同一个字符串」这条规则的兜底，摘掉之后
 * 一旦两张表漂移，脏数据会直接写进记录。
 */
function validateImageProfile(
  input: ContentImageInput,
): AdminAnnouncementProfilePatch {
  const errors = contentImageFieldErrors(input);
  const field = firstContentImageErrorField(errors);
  if (field) {
    throw new ApiError("BAD_REQUEST", errors[field] ?? ADMIN_CONTENT_PROFILE_INVALID_MESSAGE, 400);
  }

  const patch = normalizeAnnouncementProfilePatch(input);
  if (!patch) throw new ApiError("BAD_REQUEST", ADMIN_CONTENT_PROFILE_INVALID_MESSAGE, 400);
  return patch;
}

/**
 * 伪事务的失败 → 接口错误。
 *
 * 四种失败各有各的处置，合并成一句「操作失败」会让调用方不知道该刷新、该换个键
 * 还是该先取消移除。
 */
function toWriteFailure(failure: AdminContentWriteFailure): ApiError {
  switch (failure.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE, 404);
    case "removed":
      return new ApiError("BAD_REQUEST", ADMIN_ANNOUNCEMENT_REMOVED_MESSAGE, 400);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE, 400);
    default:
      // `invalid-path` 属于快捷入口（只有它有可被伪造的路径）。这条路径上出现只可能是
      // 接线错了，此时回一句通用的「校验未通过」，不编一个「路径不安全」的说法
      return new ApiError("BAD_REQUEST", ADMIN_CONTENT_PROFILE_INVALID_MESSAGE, 400);
  }
}

type TransactionOutcome = Awaited<ReturnType<typeof createAnnouncement>>;

/** 伪事务结果 → 接口结果。成功只回状态字段，界面据此就地更新那一行。 */
function toWriteResult(outcome: TransactionOutcome): AdminAnnouncementWriteResult {
  if (outcome.kind !== "ok") throw toWriteFailure(outcome);

  const { updated } = outcome.value;
  return {
    announcementId: updated.id,
    enabled: updated.enabled,
    removed: updated.removedAt !== null,
    changed: outcome.changed,
    replayed: outcome.replayed,
    updated: toAdminAnnouncementItem(updated),
  };
}

// ——————————————————————————— 四种写操作 ———————————————————————————

/**
 * 新建公告。
 *
 * 校验不过返回 400（message 是第一条字段错误），**任何数据都不会被写**。
 * 同一个幂等键第二次到达返回第一次建出来的那条（`changed:false, replayed:true`），
 * 而不是又建一条——首次请求体与重放请求体不一致时，以**第一次**的为准。
 */
export async function createAdminAnnouncement(
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminAnnouncementWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const input = validateImageProfile(readImageInput(body));

  return toWriteResult(await createAnnouncement(input, writeContext(adminId, operationId)));
}

/** 编辑公告（名称 / 图片 / 说明 / 排序 / 启用状态，一次保存）。 */
export async function updateAdminAnnouncement(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminAnnouncementWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const input = validateImageProfile(readImageInput(body));

  return toWriteResult(await updateAnnouncement(id, input, writeContext(adminId, operationId)));
}

/**
 * 启用 / 停用公告（窄写入）。
 *
 * ⚠️ 与 `updateAdminAnnouncement()` 分开：列表上的开关只应当改启用状态，
 * 而不是「读出整条记录、拼一个完整 patch 再写回去」——后者会在两位管理员
 * 同时操作时，用后写的那次把另一位刚换好的素材图覆盖回旧的那张。
 */
export async function setAdminAnnouncementEnabled(
  id: string,
  enabled: boolean,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminAnnouncementWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(
    await setAnnouncementEnabled(id, enabled, writeContext(adminId, operationId)),
  );
}

/**
 * 移除公告（软删除）。
 *
 * ⚠️ **不删记录**：已经发出去、用户看过的图，事后要能回答「当时首页上那张是什么」。
 * 移除之后用户端的公告区立刻少一条（选择函数按 `removedAt === null` 过滤），
 * 而后台用「已移除」筛选仍然查得到，记录也不会再接受编辑与启停。
 *
 * 重复移除是幂等的：不刷新时间戳、不写第二条审计。
 */
export async function removeAdminAnnouncement(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminAnnouncementWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await removeAnnouncement(id, writeContext(adminId, operationId)));
}
