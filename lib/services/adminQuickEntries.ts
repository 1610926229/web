import { ApiError } from "@/lib/api/ApiError";
import {
  countAdminContentStates,
  filterContentForAdmin,
  firstQuickEntryErrorField,
  hasQuickEntryError,
  normalizeQuickEntryProfilePatch,
  quickEntryFieldErrors,
  type ContentRemovalFilter,
  type QuickEntryFieldErrors,
  type QuickEntryInput,
} from "@/lib/constants/adminContent";
import { toAdminQuickEntryItem, toAdminQuickEntryList } from "@/lib/constants/homeContent";
import {
  IDEMPOTENCY_KEY_PATTERN,
  readBoolean,
  readIdempotencyKey,
  readInteger,
  readTrimmedString,
} from "@/lib/constants/writes";
import { getContentRepository } from "@/lib/data/contentRepository";
import {
  createQuickEntry,
  removeQuickEntry,
  setQuickEntryEnabled,
  updateQuickEntry,
  type AdminContentWriteFailure,
  type AdminWriteContext,
} from "@/lib/data/adminContentTransaction";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminContentList,
  AdminQuickEntryItem,
  AdminQuickEntryProfilePatch,
} from "@/lib/types/content";

/**
 * 管理端「首页快捷入口」服务 —— 列表、详情与四种写操作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/adminRoute.ts`）。
 *
 * 这一层负责三件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段就是 `AdminQuickEntryProfilePatch` 那些）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 生成 DTO —— 仓储实体不会流到浏览器（`removedAt` 只以 `removed: boolean` 出现）。
 *
 * 业务规则不在这里：字段取值、图标白名单、状态口径在 `lib/constants/adminContent.ts`；
 * **目标地址的最终安全判定**在 `lib/data/adminContentTransaction.ts` 的原子区段里
 * ——它必须与写入同一区间，否则「校验通过、写入之前规则变了」这种时序无人能保证。
 *
 * ⚠️ **数据源只有一份**：本文件读的快捷入口与用户端首页四宫格读的是同一个仓储
 * （`getContentRepository()`），因此这里的编辑会立刻反映到前台，不需要任何同步动作。
 */

/**
 * 服务层的失败文案。
 *
 * ⚠️ 为什么定义在这里而不是 `lib/constants/adminContent.ts`：那个文件收录的是
 * **表单字段级**的规则（「入口名称不能超过 8 个字符」），而下面是**接口级**的失败
 * （不存在 / 已移除 / 幂等键冲突）。两者受众不同——字段错误要挂到具体输入框上，
 * 这些错误只能作为整条请求的结论。取值与措辞对齐 `lib/constants/adminCategories.ts`，
 * 让管理后台各模块说同一套话。
 */
export const ADMIN_QUICK_ENTRY_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";
export const ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE = "快捷入口不存在";
export const ADMIN_QUICK_ENTRY_REMOVED_MESSAGE = "该快捷入口已移除，不能再编辑或启停";
export const ADMIN_QUICK_ENTRY_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_QUICK_ENTRY_PROFILE_INVALID_MESSAGE = "入口资料校验未通过，请检查表单";

/**
 * 目标地址不安全的最终文案。
 *
 * ⚠️ 与表单里「目标地址」那一栏的措辞**刻意一致**：同一个判定（`validateSafePath()`）
 * 的两处出口说同一句话，运营才不必分辨「这次是表单拦的还是服务端拦的」——
 * 两种情形下他要做的修改是同一件事：改成一个以 `/` 开头的本站地址。
 */
export const ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE = "目标地址必须是本站路径（以 / 开头）";

/**
 * 一次写操作的返回。
 *
 * ⚠️ 形状就是列表项 + 两个操作元信息：界面拿它**就地更新那一行**，不必再取一次列表。
 * `removedAt` 不在这里（只有 `removed: boolean`），审计字段也不在这里——
 * 后台列表要回答的是「这条还在不在」，不是「什么时候移除的」，后者走审计。
 * `replayed` 单独暴露，是因为「这个请求什么都没做」与「做了但结果一样」
 * 对调用方是两件事：前者说明这是一次重试。
 */
export type AdminQuickEntryWriteResult = AdminQuickEntryItem & {
  changed: boolean;
  replayed: boolean;
};

// ——————————————————————————— 读 ———————————————————————————

/**
 * 管理端快捷入口列表。
 *
 * ⚠️ **不分页**：四宫格在任何现实运营里都是个位数条记录，加分页只会带来
 * 「改完第 2 页的排序，第 1 页没变」这类由分页自己制造的问题（与三组内容同一口径）。
 *
 * `total` 是**未移除**的记录数，与 `items.length` 不是一回事：
 * `removal=removed` 时列表装的是已移除的那批，而运营关心的「我手上还有几条入口」
 * 是前者。两个数字各自回答一个问题，因此都在同一个响应里。
 */
export async function queryAdminQuickEntryList(
  removal: ContentRemovalFilter,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminContentList<AdminQuickEntryItem>> {
  return withMockDebug(params, surface, async () => {
    // 读的是**全部**记录（含停用与已移除）：角标要数全量，筛选在纯函数里做
    const all = await getContentRepository().listQuickEntryRecords();
    const counts = countAdminContentStates(all);

    return {
      items: toAdminQuickEntryList(filterContentForAdmin(all, removal)),
      total: counts.all - counts.removed,
      counts,
    };
  });
}

/**
 * 管理端快捷入口详情。
 *
 * ⚠️ **已移除的入口仍然返回详情**：后台要能查到「这条入口被移除过」，
 * 返回 404 等于把软移除变成了记录消失，那正是软删除要避免的事。
 */
export async function getAdminQuickEntryDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminQuickEntryItem | null> {
  return withMockDebug(params, surface, async () => {
    const record = await getContentRepository().findQuickEntryById(id);
    return record ? toAdminQuickEntryItem(record) : null;
  });
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————

function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_QUICK_ENTRY_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

/**
 * 拼装写上下文。
 *
 * ⚠️ 身份的**唯一**来源是 `requireAdmin()` 返回的会话 id：这里的 `adminId` 参数
 * 由接口层从会话里取，请求体里的 `actorId` / `role` / `actorName` 之类字段
 * **没有任何进入路径**（§九）。`actorName` 固定为 null：管理写操作的会话里
 * 本阶段就没有显示名称快照，编一个出来只会让审计里出现一个假的「谁」。
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
 * 从请求体里读出一份完整的入口输入。
 *
 * ⚠️ **入参就是白名单**：`id`、`createdAt`、`updatedAt`、`removedAt` 在这里
 * **没有读取的位置**，客户端多传一个字段也不会有任何效果。这不是「忘了校验」，
 * 而是类型上就没有入口（§九：客户端伪造 ID、状态、时间必须被忽略）。
 */
function readQuickEntryInput(body: Record<string, unknown>): QuickEntryInput {
  return {
    label: readTrimmedString(body, "label"),
    // 图标与地址都按字符串读进来，再由 `quickEntryFieldErrors()` 收窄：
    // 在读入这一步就把非字符串当成空串，比在这里猜调用方的意图更安全
    icon: readTrimmedString(body, "icon"),
    path: readTrimmedString(body, "path"),
    // 缺省用 NaN 而不是 0：NaN 会让排序校验报错，静默当成 0 等于把一个没传的字段
    // 变成一个合法值写进记录
    sortOrder: readInteger(body, "sortOrder", Number.NaN),
    enabled: readBoolean(body, "enabled", true),
  };
}

/**
 * 逐字段校验 → 可写入的 patch；任何一处不过就抛 400。
 *
 * message 是**第一条**字段错误（按页面上的字段顺序），于是表单可以把这句话
 * 直接挂到对应的输入框上，而不是给一条不知道改哪里的横幅。
 *
 * ⚠️ 这里是**路径安全的第一级**。它挡的是「根本没通过表单」的提交；
 * 第二级在事务层的原子区段内（见 `lib/data/adminContentTransaction.ts` 的
 * `invalid-path`）——写之前那一刻再判一次，两次都不能少。
 */
function validateQuickEntry(input: QuickEntryInput): AdminQuickEntryProfilePatch {
  const errors: QuickEntryFieldErrors = quickEntryFieldErrors(input);
  if (hasQuickEntryError(errors)) {
    throw new ApiError("BAD_REQUEST", firstErrorMessage(errors), 400);
  }

  const patch = normalizeQuickEntryProfilePatch(input);
  if (!patch) {
    throw new ApiError("BAD_REQUEST", ADMIN_QUICK_ENTRY_PROFILE_INVALID_MESSAGE, 400);
  }
  return patch;
}

/** 按字段顺序取第一条非空错误。全空时回一句通用文案（正常不会走到这里）。 */
function firstErrorMessage(errors: QuickEntryFieldErrors): string {
  const field = firstQuickEntryErrorField(errors);
  return (field && errors[field]) || ADMIN_QUICK_ENTRY_PROFILE_INVALID_MESSAGE;
}

/**
 * 伪事务的失败 → 接口错误。
 *
 * 四种失败各有各的处置，合并成一句「操作失败」会让调用方不知道该刷新、
 * 该改地址还是该重新生成幂等键。
 */
function toApiFailure(failure: AdminContentWriteFailure): ApiError {
  switch (failure.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE, 404);
    case "removed":
      return new ApiError("BAD_REQUEST", ADMIN_QUICK_ENTRY_REMOVED_MESSAGE, 400);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_QUICK_ENTRY_OPERATION_CONFLICT_MESSAGE, 400);
    case "invalid-path":
      // 服务层已经校验过一次，走到这里说明「校验通过之后、写入之前」地址被判为不安全
      // （或将来多了一条绕过服务层的写入路径）。宁可回一句「必须是本站路径」，
      // 也不能把它降级成「操作失败」——那会让人以为是系统抖动而反复重试
      return new ApiError("BAD_REQUEST", ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE, 400);
    default:
      return new ApiError("BAD_REQUEST", ADMIN_QUICK_ENTRY_PROFILE_INVALID_MESSAGE, 400);
  }
}

type TransactionOutcome = Awaited<ReturnType<typeof createQuickEntry>>;

/** 伪事务结果 → 接口结果。成功时回列表项的形状，界面据此就地更新那一行。 */
function toWriteResult(outcome: TransactionOutcome): AdminQuickEntryWriteResult {
  if (outcome.kind !== "ok") throw toApiFailure(outcome);

  return {
    ...toAdminQuickEntryItem(outcome.value.updated),
    changed: outcome.changed,
    replayed: outcome.replayed,
  };
}

// ——————————————————————————— 四种写操作 ———————————————————————————

/**
 * 新建快捷入口。
 *
 * 目标地址在这个文件里过 `validateSafePath()`（经由
 * `normalizeQuickEntryProfilePatch()`），在事务层的原子区段内再过一次。
 * `createdAt` / `updatedAt` 由事务在区段内取服务端时间写入，客户端传什么都不作数。
 */
export async function createAdminQuickEntry(
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminQuickEntryWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const patch = validateQuickEntry(readQuickEntryInput(body));

  return toWriteResult(await createQuickEntry(patch, writeContext(adminId, operationId)));
}

/** 编辑快捷入口（名称 / 图标 / 目标地址 / 排序 / 启用状态，一次保存）。 */
export async function updateAdminQuickEntry(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminQuickEntryWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const patch = validateQuickEntry(readQuickEntryInput(body));

  return toWriteResult(await updateQuickEntry(id, patch, writeContext(adminId, operationId)));
}

/**
 * 启用 / 停用快捷入口（窄写入）。
 *
 * ⚠️ 与 `updateAdminQuickEntry()` 分开：列表上的开关只应当改启用状态，
 * 而不是「读出整条记录、拼一个完整 patch 再写回去」——后者会在两位管理员
 * 同时操作时，用后写的那次把另一位刚改好的名称或地址覆盖回旧值。
 */
export async function setAdminQuickEntryEnabled(
  id: string,
  enabled: boolean,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminQuickEntryWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await setQuickEntryEnabled(id, enabled, writeContext(adminId, operationId)));
}

/**
 * 移除快捷入口（软移除）。
 *
 * ⚠️ **不删记录**：首页四宫格是运营每天在调的位置，事后要能回答「当时这个格子
 * 指向哪里」。因此记录保留，只是不再进用户端；后台用 `removal=removed` 仍然查得到。
 */
export async function removeAdminQuickEntry(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminQuickEntryWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await removeQuickEntry(id, writeContext(adminId, operationId)));
}
