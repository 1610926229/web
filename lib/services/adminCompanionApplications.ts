import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_APPLICATION_LIST_NOTICE,
  ADMIN_APPLICATION_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_APPLICATION_NOT_FOUND_MESSAGE,
  ADMIN_APPLICATION_OPERATION_CONFLICT_MESSAGE,
  ADMIN_APPLICATION_STATUS_INVALID_MESSAGE,
  adminApplicationTransitionMessage,
  buildAdminApplicationListQuery,
  normalizeAdminReviewNote,
  readAdminApplicationGameId,
  readAdminApplicationStatusFilter,
  toAdminCompanionApplicationDetail,
  toAdminCompanionApplicationListItem,
  type AdminApplicationListQuery,
} from "@/lib/constants/adminApplications";
import { COMPANION_APPLICATION_STATUS_LABELS } from "@/lib/constants/companionApplications";
import {
  IDEMPOTENCY_KEY_PATTERN,
  readIdempotencyKey,
  readTrimmedString,
} from "@/lib/constants/writes";
import {
  approveCompanionApplication,
  rejectCompanionApplication,
  startReviewCompanionApplication,
  type AdminWriteContext,
} from "@/lib/data/adminCompanionTransaction";
import { getCompanionApplicationRepository } from "@/lib/data/companionApplicationRepository";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import { getQualificationRepository } from "@/lib/data/qualificationRepository";
import { getDataSource } from "@/lib/data/source";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { CompanionGameTag } from "@/lib/types/companion";
import type {
  AdminApplicationListData,
  AdminApplicationReviewResult,
  AdminCompanionApplicationDetail,
  CompanionApplicationStatus,
} from "@/lib/types/companionApplication";

/**
 * 管理端「入驻审核」服务 —— 列表、详情与三个审核动作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/adminRoute.ts`），
 * 在这里再写一遍只会出现「两处规则不一致」的可能。
 *
 * 三条分工：
 * 1. **筛选与分页在数据层与常量层完成**，页面与接口都不自己过滤；
 * 2. **DTO 在这里生成**：仓储实体不会流到浏览器，`userId` 只出现在详情的
 *    申请人摘要里（管理员要据此判断「这个人是不是已经有一条护航了」）；
 * 3. **写操作一律经伪事务**（`lib/data/adminCompanionTransaction.ts`）：
 *    这里只负责解析入参、把失败翻译成明确的接口错误、把成功翻译成 DTO。
 *    业务规则（合法迁移、拒绝必须有意见）不在这里判断——那两处在常量层。
 */

/**
 * 列表页一次取回的全部数据（一页申请 + 筛选栏选项 + 各状态角标）。
 *
 * 类型定义在 `lib/types/companionApplication.ts`：浏览器端的 `adminHttp.ts`
 * 拿的是同一个形状，定义放两边迟早会漂移。
 */
export type { AdminApplicationListData };

/**
 * 解析列表查询条件。与陪玩列表同一套约定：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 *
 * 状态筛选与游戏筛选都要解析，因为它们都会**改变查到的数据**——
 * 一个手改坏的游戏 id 若静默按「全部游戏」处理，页面会显示一批与筛选栏不符的记录。
 */
export async function resolveAdminApplicationListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminApplicationListQuery> {
  const knownGameIds = (await getDataSource().getGames()).map((game) => game.id);

  const status = readAdminApplicationStatusFilter(params.get("status"));
  const gameId = readAdminApplicationGameId(params.get("gameId"), knownGameIds);

  if (strict) {
    if (status === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_APPLICATION_STATUS_INVALID_MESSAGE, 400);
    }
    if (gameId === null) {
      throw new ApiError("BAD_REQUEST", "筛选条件 gameId 不是有效的游戏", 400);
    }
  }

  return buildAdminApplicationListQuery({
    params,
    status: status ?? "pending",
    gameId: gameId ?? "",
  });
}

/** 一次把「游戏 id → 名称」与「游戏选项」都取回来，两处用的是同一份游戏数据。 */
async function gameContext(): Promise<{
  names: Record<string, string>;
  options: CompanionGameTag[];
}> {
  const games = await getDataSource().getGames();
  return {
    names: Object.fromEntries(games.map((game) => [game.id, game.name])),
    options: games.map((game) => ({ id: game.id, name: game.name })),
  };
}

/**
 * 管理端申请列表。
 *
 * `?mockEmpty=applications` 演示空列表（**空数据不是错误**，不抛错，由页面渲染空态）；
 * `?mockError=…` 由 `withMockDebug` 统一处理。两个参数都只在 `ENABLE_MOCK_DEBUG=true`
 * 时生效，且都在这一层处理——`app/admin/**` 下的页面不引用 `lib/mocks`。
 */
export async function queryAdminApplicationList(
  query: AdminApplicationListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminApplicationListData> {
  return withMockDebug(params, surface, async () => {
    const [{ names, options }, counts] = await Promise.all([
      gameContext(),
      getCompanionApplicationRepository().countApplicationsByStatus(),
    ]);

    if (mockEmptyApplies(params, "applications")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        games: options,
        counts,
        notice: ADMIN_APPLICATION_LIST_NOTICE,
      };
    }

    const rows = await getCompanionApplicationRepository().queryApplicationsForAdmin({
      status: query.status === "all" ? null : query.status,
      keyword: query.keyword,
      gameId: query.gameId,
    });

    // 分页在这一层：数据层只回答「符合条件的有哪些、什么顺序」
    const start = (query.page - 1) * query.pageSize;
    const items = rows
      .slice(start, start + query.pageSize)
      .map((application) => toAdminCompanionApplicationListItem(application, names));

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: rows.length,
      hasMore: start + items.length < rows.length,
      games: options,
      counts,
      notice: ADMIN_APPLICATION_LIST_NOTICE,
    };
  });
}

/**
 * 管理端申请详情。
 *
 * 不存在返回 null，由页面 `notFound()`。申请人摘要三样都要查：
 * 用户昵称、已经关联的护航、是否已有资格——**§七 的「一名用户最多一条有效护航」
 * 在界面上就体现在后两项**，审核的人据此知道这次通过会新建资料还是复用已有的一条。
 */
export async function getAdminApplicationDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminCompanionApplicationDetail | null> {
  return withMockDebug(params, surface, async () => {
    const application = await getCompanionApplicationRepository().findApplicationById(id);
    if (!application) return null;

    const { names } = await gameContext();

    const [user, linkedCompanion, qualification] = await Promise.all([
      getDataSource().findUserById(application.userId),
      getCompanionRepository().findCompanionByUser(application.userId),
      getQualificationRepository().findQualification(application.userId, "companion"),
    ]);

    return toAdminCompanionApplicationDetail(application, names, {
      userId: application.userId,
      nickname: user?.nickname ?? "",
      linkedCompanionId: linkedCompanion?.id ?? null,
      hasCompanionQualification: qualification !== null,
    });
  });
}

// ——————————————————————————— 三个审核动作 ———————————————————————————

/**
 * 从请求体里取幂等键。
 *
 * ⚠️ **不能依赖按钮禁用防重**（§九）：按钮只能挡住手快，挡不住网络重试与用户刷新后重发，
 * 也挡不住直接请求接口。真正的防重是这里读到的幂等键，加上伪事务里的重放判定。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key) {
    throw new ApiError("BAD_REQUEST", ADMIN_APPLICATION_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

/**
 * 幂等键格式的说明性检查。
 *
 * `readIdempotencyKey()` 已经做过一次格式校验，这里保留一条**独立的**断言，
 * 是为了让「幂等键必须是客户端生成、同一意图下保持不变的字符串」这件事
 * 在本文件里也留下痕迹——它同时是审计表的 `operationId` 来源。
 */
function assertIdempotencyKeyShape(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_APPLICATION_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
}

/** 组装一次写操作的上下文。时间戳只取一次，业务写入与审计写入共用同一个。 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return { adminId, operationId, at: new Date().toISOString() };
}

/** 把伪事务的「不合法迁移」翻译成带当前状态的 400（文案取自常量层）。 */
function invalidTransition(status: CompanionApplicationStatus): ApiError {
  return new ApiError("BAD_REQUEST", adminApplicationTransitionMessage(status), 400);
}

function toReviewResult(
  application: { id: string; status: CompanionApplicationStatus; reviewedAt: string | null },
  changed: boolean,
  companionId?: string,
): AdminApplicationReviewResult {
  return {
    applicationId: application.id,
    status: application.status,
    statusLabel: COMPANION_APPLICATION_STATUS_LABELS[application.status],
    reviewedAt: application.reviewedAt,
    changed,
    ...(companionId ? { companionId } : {}),
  };
}

/**
 * 开始审核：`pending → reviewing`。
 *
 * 只改状态。**不通过、不建护航、不发资格**——这一步的含义就是「有人开始看了」。
 */
export async function startReviewAdminApplication(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminApplicationReviewResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const outcome = await startReviewCompanionApplication(id, writeContext(adminId, operationId));

  switch (outcome.kind) {
    case "not-found":
      throw new ApiError("NOT_FOUND", ADMIN_APPLICATION_NOT_FOUND_MESSAGE, 404);
    case "invalid-transition":
      throw invalidTransition(outcome.status);
    case "operation-conflict":
      throw new ApiError("BAD_REQUEST", ADMIN_APPLICATION_OPERATION_CONFLICT_MESSAGE, 400);
    default:
      return toReviewResult(outcome.value, outcome.changed);
  }
}

/**
 * 通过：`pending | reviewing → approved`。
 *
 * 一次请求产生四样写入（申请状态、资格、护航、审计），全部在同一段无 `await`
 * 的区段里完成，因此不会出现「状态通过了但护航没建出来」的中间态。
 * 返回里带上 `companionId`：审核的人据此知道这个人现在对应哪一条护航资料。
 */
export async function approveAdminApplication(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminApplicationReviewResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const outcome = await approveCompanionApplication(id, writeContext(adminId, operationId));

  switch (outcome.kind) {
    case "not-found":
      throw new ApiError("NOT_FOUND", ADMIN_APPLICATION_NOT_FOUND_MESSAGE, 404);
    case "invalid-transition":
      throw invalidTransition(outcome.status);
    case "operation-conflict":
      throw new ApiError("BAD_REQUEST", ADMIN_APPLICATION_OPERATION_CONFLICT_MESSAGE, 400);
    default:
      return toReviewResult(outcome.value.application, outcome.changed, outcome.value.companion.id);
  }
}

/**
 * 拒绝：`pending | reviewing → rejected`。
 *
 * ⚠️ **必须填写审核意见**，规则在 `normalizeAdminReviewNote()` 一处。
 * 拒绝**不产生护航资料、不发资格**——这正是它与通过的分界。
 */
export async function rejectAdminApplication(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminApplicationReviewResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const note = normalizeAdminReviewNote(readTrimmedString(body, "reviewNote"));
  if (!note.ok) throw new ApiError("BAD_REQUEST", note.message, 400);

  const outcome = await rejectCompanionApplication(
    id,
    note.value,
    writeContext(adminId, operationId),
  );

  switch (outcome.kind) {
    case "not-found":
      throw new ApiError("NOT_FOUND", ADMIN_APPLICATION_NOT_FOUND_MESSAGE, 404);
    case "invalid-transition":
      throw invalidTransition(outcome.status);
    case "operation-conflict":
      throw new ApiError("BAD_REQUEST", ADMIN_APPLICATION_OPERATION_CONFLICT_MESSAGE, 400);
    default:
      return toReviewResult(outcome.value, outcome.changed);
  }
}
