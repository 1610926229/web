import { ApiError } from "@/lib/api/ApiError";
import {
  contentImageFieldErrors,
  countAdminContentStates,
  filterContentForAdmin,
  firstContentImageErrorField,
  normalizeBannerProfilePatch,
  type ContentImageInput,
} from "@/lib/constants/adminContent";
import { toAdminBannerItem, toAdminBannerList } from "@/lib/constants/homeContent";
import {
  IDEMPOTENCY_KEY_PATTERN,
  readBoolean,
  readIdempotencyKey,
  readInteger,
  readTrimmedString,
} from "@/lib/constants/writes";
import {
  createBanner,
  removeBanner,
  setBannerEnabled,
  updateBanner,
  type AdminContentWriteFailure,
  type AdminWriteContext,
} from "@/lib/data/adminContentTransaction";
import { getContentRepository } from "@/lib/data/contentRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { AdminBannerItem, AdminBannerProfilePatch, AdminContentList } from "@/lib/types/content";
import {
  ADMIN_CONTENT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE,
  ADMIN_CONTENT_PROFILE_INVALID_MESSAGE,
  resolveAdminContentListQuery,
  type AdminContentListQuery,
} from "./adminAnnouncements";

/**
 * 管理端「活动 Banner」服务 —— 列表、详情与四种写操作的唯一入口。
 *
 * 与图片公告（`lib/services/adminAnnouncements.ts`）是**同一种数据、同一套规则**：
 * 一张图 + 一个后台标题 + 一句读屏说明 + 排序 + 启用。两者真正的差别只有一处，
 * 而那一处在**用户端**（见下），因此这里不需要为了「Banner 有点不一样」另起一套写法。
 *
 * ## ⚠️ 后台可以有很多张，用户端永远只有一张
 *
 * 这是 §三 冻结口径里最要紧的一条：运营要能**提前备好**多张素材（换活动时切一下排序
 * 或启用状态即可），但首页的活动位不是轮播，`selectActivityImageUrl()` 只取
 * `enabled === true` → `sortOrder` 升序 → `id` 升序的第一条。
 *
 * 因此本文件的每一种写操作都必须让用户端**立刻**跟着变：
 * - 改 `sortOrder` 把某张排到最前 → 用户刷新后看到的就是那张；
 * - 停用当前生效的那张 → 自动回落到下一张启用中的（一张都不剩时回落成空串，
 *   首页据此隐藏活动位——**不返回占位图**，那会让「后台一张都没配」看起来像配好了）。
 *
 * ⚠️ 数据源只有一份：本文件与首页活动位读的是同一个仓储，没有第二份 Banner 名单，
 * 也没有「发布」这一步——保存即是生效。
 */

/**
 * 列表条件与它的解析函数**与公告共用同一份**（筛选只有一个 `removal` 轴，两者一模一样），
 * 这里再导出一次，是为了让 Banner 的接口文件只 import 一个服务模块——否则
 * 「活动图的列表条件从公告服务里取」会在阅读时产生一次没有意义的跳转。
 */
export type { AdminContentListQuery };
export { resolveAdminContentListQuery };

/** 活动 Banner 自己的两句；公告有同形的两句（`lib/services/adminAnnouncements.ts`）。 */
export const ADMIN_BANNER_NOT_FOUND_MESSAGE = "活动图不存在";
export const ADMIN_BANNER_REMOVED_MESSAGE = "该活动图已移除，不能再编辑或启停";

/**
 * 写操作的结果（四种写操作共用）。
 *
 * ⚠️ 与公告那份**逐字同形**却各自定义：两者的字段将来未必一直一样
 * （比如活动图可能多一个「投放时间段」），合成一个类型只会让「给 Banner 加字段」
 * 变成一次波及公告的改动。字段含义与那两处刻意保留的差异见
 * `AdminAnnouncementWriteResult` 的注释。
 */
export type AdminBannerWriteResult = {
  bannerId: string;
  enabled: boolean;
  removed: boolean;
  changed: boolean;
  replayed: boolean;
  /** 服务端确认之后的那条记录；含义与「重放时返回第一次的结果」见公告那份的注释。 */
  updated: AdminBannerItem;
};

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 管理端活动图列表。
 *
 * 与公告列表同一套筛选与角标口径（`resolveAdminContentListQuery()` 就是那一份）。
 * 列表按 `sortOrder` → `id` 排序，且与用户端的挑选顺序**同一个全序**：
 * 列表里的第一条，就是此刻用户端活动位上的那一张。运营调完顺序不必再去首页猜。
 */
export async function queryAdminBannerList(
  query: AdminContentListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminContentList<AdminBannerItem>> {
  return withMockDebug(params, surface, async () => {
    const all = await getContentRepository().listBannerRecords();
    const counts = countAdminContentStates(all);

    // 空态注入沿用首页的 `activity` 范围：它指的就是这一组记录（理由同公告列表）
    const items = mockEmptyApplies(params, "activity")
      ? []
      : toAdminBannerList(filterContentForAdmin(all, query.removal));

    return { items, total: counts.all - counts.removed, counts };
  });
}

/**
 * 管理端活动图详情。
 *
 * ⚠️ **已移除的仍然返回详情**：后台要能查到「这张素材被移除过」，
 * 返回 404 等于把软删除做成了记录消失。
 */
export async function getAdminBannerDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminBannerItem | null> {
  return withMockDebug(params, surface, async () => {
    const record = await getContentRepository().findBannerById(id);
    return record ? toAdminBannerItem(record) : null;
  });
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————

/**
 * 下面这几个私有函数与公告服务里那几个**逐字相同**，仍然是各写一份。
 *
 * 不是偷懒也不是复制粘贴：它们各自绑定一条独立的写入链路（写的是不同的 Map、
 * 抛的是不同的文案、算的是不同的 audit target），抽成「通用素材写入器」之后
 * 签名会退化成 `writeContent(kind, ...)`——一个拼错的 kind 在运行期才炸，
 * 而拼错的函数名编译期就炸。三组内容各自只有四个函数，写全比省下这几十行更值
 * （与 `lib/data/adminContentTransaction.ts` 里不抽泛型工厂是同一条理由）。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_CONTENT_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

/** 身份只来自 `requireAdmin()` 的会话；请求体里的 actor 字段没有读取的位置。 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return {
    actorId: adminId,
    actorRole: "admin",
    actorName: null,
    operationId,
    at: new Date().toISOString(),
  };
}

/** 入参就是白名单：`id` / `createdAt` / `updatedAt` / `removedAt` 在这里没有位置。 */
function readImageInput(body: Record<string, unknown>): ContentImageInput {
  return {
    title: readTrimmedString(body, "title"),
    imageUrl: readTrimmedString(body, "imageUrl"),
    alt: readTrimmedString(body, "alt"),
    sortOrder: readInteger(body, "sortOrder", Number.NaN),
    enabled: readBoolean(body, "enabled", true),
  };
}

/** 校验不过就 400，message 是第一条字段错误（按页面字段顺序）。 */
function validateImageProfile(input: ContentImageInput): AdminBannerProfilePatch {
  const errors = contentImageFieldErrors(input);
  const field = firstContentImageErrorField(errors);
  if (field) {
    throw new ApiError("BAD_REQUEST", errors[field] ?? ADMIN_CONTENT_PROFILE_INVALID_MESSAGE, 400);
  }

  const patch = normalizeBannerProfilePatch(input);
  if (!patch) throw new ApiError("BAD_REQUEST", ADMIN_CONTENT_PROFILE_INVALID_MESSAGE, 400);
  return patch;
}

function toWriteFailure(failure: AdminContentWriteFailure): ApiError {
  switch (failure.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_BANNER_NOT_FOUND_MESSAGE, 404);
    case "removed":
      return new ApiError("BAD_REQUEST", ADMIN_BANNER_REMOVED_MESSAGE, 400);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE, 400);
    default:
      // `invalid-path` 属于快捷入口，这条路径上出现只可能是接线错了（理由同公告服务）
      return new ApiError("BAD_REQUEST", ADMIN_CONTENT_PROFILE_INVALID_MESSAGE, 400);
  }
}

type TransactionOutcome = Awaited<ReturnType<typeof createBanner>>;

function toWriteResult(outcome: TransactionOutcome): AdminBannerWriteResult {
  if (outcome.kind !== "ok") throw toWriteFailure(outcome);

  const { updated } = outcome.value;
  return {
    bannerId: updated.id,
    enabled: updated.enabled,
    removed: updated.removedAt !== null,
    changed: outcome.changed,
    replayed: outcome.replayed,
    updated: toAdminBannerItem(updated),
  };
}

// ——————————————————————————— 四种写操作 ———————————————————————————

/**
 * 新建活动图。
 *
 * ⚠️ 新建**不会**自动把已有的那张挤下去：用户端只认排序最前的一张，
 * 因此一张新素材要真的上线，要么把它的 `sortOrder` 调到最前，要么停用当前那张
 * ——这两件事都能在同一个编辑表单里做完，但都不该由「新建」隐式触发
 * （运营提前备好的素材不应该一建出来就顶掉正在投的活动）。
 */
export async function createAdminBanner(
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminBannerWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const input = validateImageProfile(readImageInput(body));

  return toWriteResult(await createBanner(input, writeContext(adminId, operationId)));
}

/**
 * 编辑活动图（名称 / 图片 / 说明 / 排序 / 启用状态，一次保存）。
 *
 * 改 `sortOrder` 或 `enabled` 就是在切换首页上那一张，保存即刻生效。
 */
export async function updateAdminBanner(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminBannerWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const input = validateImageProfile(readImageInput(body));

  return toWriteResult(await updateBanner(id, input, writeContext(adminId, operationId)));
}

/**
 * 启用 / 停用活动图（窄写入）。
 *
 * ⚠️ 与编辑分开：列表上的开关只应当改这一个字段，否则两位管理员同时操作时，
 * 后写的那次会把另一位刚换好的素材图覆盖回旧的那张。
 *
 * 停用当前生效的那张之后，用户端会自动回落到下一张启用中的（不是变成空白，
 * 也不是继续显示已停用的那张）。
 */
export async function setAdminBannerEnabled(
  id: string,
  enabled: boolean,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminBannerWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await setBannerEnabled(id, enabled, writeContext(adminId, operationId)));
}

/**
 * 移除活动图（软删除）。
 *
 * ⚠️ **不删记录**：已经投出去过的那张图，事后要能回答「当时首页上是什么」。
 * 移除之后用户端立刻换一张（或回落成空串隐藏活动位），而后台仍可查到它。
 * 重复移除幂等：不刷新时间戳、不写第二条审计。
 */
export async function removeAdminBanner(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminBannerWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await removeBanner(id, writeContext(adminId, operationId)));
}
