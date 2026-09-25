import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_COMPANION_DISABLED_MESSAGE,
  ADMIN_COMPANION_LIST_NOTICE,
  ADMIN_COMPANION_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_COMPANION_NOT_FOUND_MESSAGE,
  ADMIN_COMPANION_OPERATION_CONFLICT_MESSAGE,
  ADMIN_COMPANION_PROFILE_INVALID_MESSAGE,
  ADMIN_COMPANION_REMOVED_MESSAGE,
  ADMIN_COMPANION_STATE_INVALID_MESSAGE,
  ADMIN_COMPANION_REMOVAL_INVALID_MESSAGE,
  adminCompanionStateToFilter,
  buildAdminCompanionListQuery,
  companionProfileFieldErrors,
  hasCompanionProfileError,
  normalizeCompanionProfilePatch,
  normalizeCompanionReason,
  readAdminCompanionRemovalFilter,
  readAdminCompanionStateFilter,
  toAdminCompanionListItem,
  type AdminCompanionListQuery,
  type CompanionProfileInput,
} from "@/lib/constants/adminCompanions";
import { readCompanionGameId } from "@/lib/constants/companions";
import { ORDER_DATA_INCONSISTENT_MESSAGE } from "@/lib/constants/dispatch";
import { countCompanionStates } from "@/lib/constants/admin";
import {
  IDEMPOTENCY_KEY_PATTERN,
  readBoolean,
  readIdempotencyKey,
  readInteger,
  readStringArray,
  readTrimmedString,
} from "@/lib/constants/writes";
import {
  removeCompanion,
  setCompanionFlags,
  updateCompanionProfile,
  type AdminCompanionWriteResult as TransactionWriteResult,
  type AdminWriteContext,
  type CompanionFlagIntent,
} from "@/lib/data/adminCompanionTransaction";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import { getDataSource } from "@/lib/data/source";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminCompanionDetail,
  AdminCompanionListData,
  AdminCompanionWriteResult,
  CompanionGameOption,
} from "@/lib/types/companion";

/**
 * 管理端「护航管理」服务 —— 列表、详情与六种写操作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处。
 *
 * 这一层负责三件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段就是 `AdminCompanionProfilePatch` 那些）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 生成 DTO —— 仓储实体不会流到浏览器。
 *
 * 业务规则不在这里：合法状态、字段取值、大区与游戏的匹配都在
 * `lib/constants/adminCompanions.ts`，读写与审计同区间的保证在
 * `lib/data/adminCompanionTransaction.ts`。
 *
 * ⚠️ **数据源只有一份**：本文件读的护航名单与用户端列表 / 详情 / 结算页
 * 是同一个仓储（`getCompanionRepository()`），因此这里的编辑会立刻反映到前台，
 * 不需要任何同步动作。
 */

/**
 * 列表页一次取回的全部数据（一页护航 + 筛选栏选项 + 各状态角标）。
 *
 * 类型定义在 `lib/types/companion.ts`：浏览器端的 `adminHttp.ts` 拿的是同一个形状，
 * 定义放两边迟早会漂移。
 */
export type { AdminCompanionListData };

/**
 * 解析列表查询条件。约定与其它管理列表一致：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 */
export async function resolveAdminCompanionListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminCompanionListQuery> {
  const knownGameIds = (await getDataSource().getGames()).map((game) => game.id);

  const state = readAdminCompanionStateFilter(params.get("state"));
  const removal = readAdminCompanionRemovalFilter(params.get("removal"));
  const gameId = readCompanionGameId(params.get("gameId"), knownGameIds);

  if (strict) {
    if (state === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_COMPANION_STATE_INVALID_MESSAGE, 400);
    }
    if (removal === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_COMPANION_REMOVAL_INVALID_MESSAGE, 400);
    }
    if (gameId === null) throw new ApiError("BAD_REQUEST", "筛选条件 gameId 不是有效的游戏", 400);
  }

  return buildAdminCompanionListQuery({
    params,
    gameId: gameId ?? "",
    state: state ?? "all",
    removal: removal ?? "active",
  });
}

/** 一次把「游戏 id → 名称」与「筛选栏选项」都取回来，两处用的是同一份游戏数据。 */
async function gameContext(): Promise<{
  names: Record<string, string>;
  options: { id: string; name: string }[];
}> {
  const games = await getDataSource().getGames();
  return {
    names: Object.fromEntries(games.map((game) => [game.id, game.name])),
    options: games.map((game) => ({ id: game.id, name: game.name })),
  };
}

/**
 * 管理端护航列表。
 *
 * 走的是仓储里**唯一**的那份名单（含停用与已移除的记录），
 * 因此「后台看到全部、用户端只看到在架且未移除的」这件事由数据层保证，
 * 页面不自己过滤。
 */
export async function queryAdminCompanionList(
  query: AdminCompanionListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCompanionListData> {
  return withMockDebug(params, surface, async () => {
    const [{ names, options }, all] = await Promise.all([
      gameContext(),
      getCompanionRepository().listCompanionsForAdmin(),
    ]);

    // 角标口径与概览页共用 `countCompanionStates()`：已移除的记录**不进**任何角标
    // ——它们已经不在名单里了，算进「已停用」会让两个页面的数字对不上
    const counts = countCompanionStates(all.filter((companion) => companion.removedAt === null));

    if (mockEmptyApplies(params, "companions")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        games: options,
        counts,
        notice: ADMIN_COMPANION_LIST_NOTICE,
      };
    }

    const flags = adminCompanionStateToFilter(query.state);
    const rows = await getCompanionRepository().queryCompanionsForAdmin({
      keyword: query.keyword,
      gameId: query.gameId,
      enabled: flags.enabled,
      availability: flags.availability,
      removal: query.removal,
    });

    const start = (query.page - 1) * query.pageSize;
    const items = rows
      .slice(start, start + query.pageSize)
      .map((companion) => toAdminCompanionListItem(companion, names));

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: rows.length,
      hasMore: start + items.length < rows.length,
      games: options,
      counts,
      notice: ADMIN_COMPANION_LIST_NOTICE,
    };
  });
}

/**
 * 管理端护航详情。
 *
 * ⚠️ **已移除的记录仍然返回详情**：后台要能查到「这个人被移除过」，
 * 返回 404 等于把移除变成了「记录消失」，那正是软删除要避免的事。
 */
export async function getAdminCompanionDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCompanionDetail | null> {
  return withMockDebug(params, surface, async () => {
    const [companion, { names }] = await Promise.all([
      getCompanionRepository().findCompanionById(id),
      gameContext(),
    ]);

    return companion ? toAdminCompanionListItem(companion, names) : null;
  });
}

/**
 * 编辑表单要用的游戏选项（含每个游戏的大区）。
 *
 * ⚠️ 只读**展示所需**的字段：游戏目录里可能还有图标、排序等内部字段，
 * 表单一个都用不上，多传一份出去只会让客户端 DTO 悄悄长胖。
 * 大区必须与所选游戏匹配，因此这份映射是表单能给出正确选项的前提。
 */
export async function getAdminCompanionFormOptions(): Promise<{
  games: CompanionGameOption[];
}> {
  const games = await getDataSource().getGames();
  return {
    games: games.map((game) => ({ id: game.id, name: game.name, regions: [...game.regions] })),
  };
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_COMPANION_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
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
 * 伪事务的写结果 → 接口结果。
 *
 * 成功时**只回状态字段**（启用、可接单、原因、移除时间、是否真的改了）：
 * 界面据此就地更新那一行，不需要为了刷新一个开关重新拉一整页。
 * 失败时按类型翻译成明确的接口错误——三种失败各有各的处置，
 * 合并成一句「操作失败」会让调用方不知道该刷新还是该换个人试。
 */
function toWriteResult(result: TransactionWriteResult, companionId: string): AdminCompanionWriteResult {
  switch (result.kind) {
    case "not-found":
      throw new ApiError("NOT_FOUND", ADMIN_COMPANION_NOT_FOUND_MESSAGE, 404);
    case "removed":
      throw new ApiError("BAD_REQUEST", ADMIN_COMPANION_REMOVED_MESSAGE, 400);
    case "disabled":
      throw new ApiError("BAD_REQUEST", ADMIN_COMPANION_DISABLED_MESSAGE, 400);
    case "operation-conflict":
      throw new ApiError("BAD_REQUEST", ADMIN_COMPANION_OPERATION_CONFLICT_MESSAGE, 400);
    // P0-11：停用要连带解除他手上的订单，而那份数据不自洽。**停用本身也一笔没写**，
    // 因此不能报成任何一种 400——那会让管理员以为是自己操作的问题而反复重试同一件事
    case "inconsistent":
      throw new ApiError("SERVER_ERROR", ORDER_DATA_INCONSISTENT_MESSAGE, 500);
    default: {
      const { enabled, available, unavailableReason, removedAt } = result.value.updated;
      return {
        companionId,
        enabled,
        available,
        unavailableReason,
        removedAt,
        changed: result.changed,
      };
    }
  }
}

// ——————————————————————————— 编辑资料（PATCH） ———————————————————————————

/**
 * 从请求体里读出一份完整的资料输入。
 *
 * ⚠️ **入参就是白名单**：统计、关联用户、来源申请、移除时间在这里**没有读取的位置**，
 * 客户端多传一个字段也不会有任何效果。这不是「忘了校验」，而是类型上就没有入口。
 */
function readProfileInput(body: Record<string, unknown>): CompanionProfileInput {
  return {
    displayName: readTrimmedString(body, "displayName"),
    avatarUrl: readTrimmedString(body, "avatarUrl"),
    intro: readTrimmedString(body, "intro"),
    gameIds: readStringArray(body, "gameIds"),
    regions: readStringArray(body, "regions"),
    serviceTags: readStringArray(body, "serviceTags"),
    enabled: readBoolean(body, "enabled", true),
    available: readBoolean(body, "available", false),
    unavailableReason: readTrimmedString(body, "unavailableReason"),
    // 缺省用 NaN 而不是 0：NaN 会让「展示排序只能是…」的校验报错，
    // 静默当成 0 等于把一个没传的字段变成一个合法值写进记录
    sortOrder: readInteger(body, "sortOrder", Number.NaN),
  };
}

/**
 * 编辑护航资料。
 *
 * 校验分两步：先算出一份**逐字段**的错误（页面拿它做 `aria-invalid` / `aria-describedby`），
 * 再交给 `normalizeCompanionProfilePatch()` 生成入参。第二步会再校验一次——
 * 「忘了先校验」因此不可能写进脏数据。
 *
 * 返回 400 时把**第一条**错误放进 message：接口调用方看不到表单，
 * 至少要能从响应里知道是哪个字段不对。
 */
export async function updateAdminCompanion(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCompanionWriteResult> {
  const operationId = requireIdempotencyKey(body);

  const games = await getDataSource().getGames();
  const input = readProfileInput(body);

  const errors = companionProfileFieldErrors(input, games);
  if (hasCompanionProfileError(errors)) {
    throw new ApiError("BAD_REQUEST", firstErrorMessage(errors), 400);
  }

  const patch = normalizeCompanionProfilePatch(input, games);
  if (!patch) throw new ApiError("BAD_REQUEST", ADMIN_COMPANION_PROFILE_INVALID_MESSAGE, 400);

  return toWriteResult(
    await updateCompanionProfile(id, patch, writeContext(adminId, operationId)),
    id,
  );
}

function firstErrorMessage(errors: Record<string, string | null>): string {
  for (const message of Object.values(errors)) {
    if (message) return message;
  }
  return ADMIN_COMPANION_PROFILE_INVALID_MESSAGE;
}

// ——————————————————————————— 四个接单状态动作 ———————————————————————————

/**
 * 暂停 / 恢复 / 启用 / 停用。四个动作走同一条写入路径，只是目标状态不同。
 *
 * 暂停接单要给出原因（§八：不可接单必须有原因），规则与编辑表单共用同一个常量；
 * 其余三个动作的原因由服务端按规则处理（恢复时清空、停用时保留），不由客户端传。
 */
export async function setAdminCompanionFlags(
  id: string,
  intent: CompanionFlagIntent,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCompanionWriteResult> {
  const operationId = requireIdempotencyKey(body);

  // 原因由**同一个函数**校验：界面没有 `maxLength`，超长只能在提交时被明确拒绝。
  // 客户端拦住之后这里仍然要校验一遍——接口可以被直接调用，绕过界面。
  const reason = normalizeCompanionReason(readTrimmedString(body, "unavailableReason"));
  if (intent === "pause" && !reason.ok) {
    throw new ApiError("BAD_REQUEST", reason.message, 400);
  }

  return toWriteResult(
    await setCompanionFlags(
      id,
      intent,
      { unavailableReason: reason.ok ? reason.value : "" },
      writeContext(adminId, operationId),
    ),
    id,
  );
}

/**
 * 移除护航（软删除）。
 *
 * ⚠️ 移除**不删除任何历史**：订单、评价与鸡腿记录都保留，只是用户端看不到这条资料了。
 * 后台可以用「已移除」筛选把它找回来。
 */
export async function removeAdminCompanion(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminCompanionWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await removeCompanion(id, writeContext(adminId, operationId)), id);
}
