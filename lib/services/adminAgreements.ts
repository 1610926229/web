import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_AGREEMENT_LIST_NOTICE,
  ADMIN_AGREEMENT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_AGREEMENT_NOT_FOUND_MESSAGE,
  ADMIN_AGREEMENT_OPERATION_CONFLICT_MESSAGE,
  ADMIN_AGREEMENT_PROFILE_INVALID_MESSAGE,
  agreementProfileFieldErrors,
  hasAgreementProfileError,
  normalizeAgreementProfilePatch,
  sortAgreementsForAdmin,
  toAdminAgreementDetail,
  toAdminAgreementListItem,
  toAdminAgreementWriteResult,
  type AgreementProfileInput,
  type AgreementSectionInput,
} from "@/lib/constants/adminAgreements";
import { AGREEMENT_TYPES } from "@/lib/constants/agreements";
import { readBoolean, readIdempotencyKey, readTrimmedString } from "@/lib/constants/writes";
import { getAgreementRepository } from "@/lib/data/agreementRepository";
import {
  setAgreementEnabled,
  updateAgreement,
  type AdminAgreementWriteFailure,
  type AdminAgreementWriteOutcome,
  type AdminWriteContext,
} from "@/lib/data/adminAgreementTransaction";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminAgreementDetail,
  AdminAgreementListData,
  AdminAgreementWriteResult,
  AgreementType,
} from "@/lib/types/agreement";

/**
 * 管理端「协议管理」服务 —— 列表、详情与两种写操作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处
 * （`lib/api/adminRoute.ts`，理由见那里的注释）。
 *
 * ⚠️ **这一层不是「用户端协议服务的复刻」**：用户端读的是
 * `lib/services/agreements.ts`（公开、游客可见、不含配置字段），
 * 两者读的是**同一份数据**，但对外形状与权限完全不同。把它们合成一个服务，
 * 迟早会出现「某个入口忘了挑字段，把 `enabled` 发给了用户端」。
 *
 * 这一层负责三件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段就是 `AdminAgreementProfilePatch` 那些）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 生成 DTO —— 仓储实体不会流到浏览器。
 *
 * 业务规则不在这里：字段取值与「正文是不是纯文本」在
 * `lib/constants/adminAgreements.ts`；**版本号递增**与「这次算不算改动」
 * 在 `lib/data/adminAgreementTransaction.ts` 的原子区段里——它们必须与写入同一区间，
 * 否则两位管理员同时保存会各自基于同一个旧版本号算出同一个新版本号。
 */

export type { AdminAgreementDetail, AdminAgreementListData };

/**
 * 列表查询条件。
 *
 * 本阶段**没有筛选维度**：协议是固定五项，一次全部返回。这里仍然给出一个形状，
 * 是因为「列表查询」这件事在管理端是一套统一的调用约定
 * （`resolveXxxListQuery()` → `queryXxxList()`），页面与接口都不该为某一个模块
 * 破例去直接调仓储。
 */
export type AdminAgreementListQuery = {
  /**
   * 要列出的协议类型，**顺序即返回顺序**。
   *
   * 本阶段固定为 `AGREEMENT_TYPES`（页签顺序）。放在查询里而不是写死在排序函数里，
   * 是为了让「页签顺序」这件事只有一个来源：将来若要支持「只列某一类」，
   * 从这里收窄即可，排序规则不用改。
   */
  readonly types: readonly AgreementType[];
};

/** 本阶段唯一的查询形状。常量而不是每次新建对象：它是不可变的。 */
const ADMIN_AGREEMENT_LIST_QUERY: AdminAgreementListQuery = { types: AGREEMENT_TYPES };

/**
 * 解析列表查询条件。
 *
 * ⚠️ `params` 在本阶段**有意不使用**：协议列表没有筛选、没有分页、没有关键字。
 * 保留这个参数是为了让接口层与页面的调用形状与其它管理列表一致
 * （`resolveXxxListQuery(searchParams)`），将来加筛选时也是从这里进。
 */
export function resolveAdminAgreementListQuery(
  params: URLSearchParams | undefined,
): AdminAgreementListQuery {
  // 显式「用」一下参数：表示读过了、确认没有可解析的维度，而不是漏接了
  void params;
  return ADMIN_AGREEMENT_LIST_QUERY;
}

/**
 * 管理端协议列表。
 *
 * 走的是仓储里**唯一**的那份协议表，**不筛掉停用的记录**：停用是可逆的，
 * 列表上必须看得见那条被停用的协议，否则它永远无法被重新启用。
 * 「用户端只看得到启用项」是另一条路径上的规则（`pickCurrentAgreements()`），
 * 两者在同一份原始数据上各做各的事。
 *
 * `?mockEmpty=agreements` 用于验收「一条协议都没有」时的空态——预置数据里五类齐全，
 * 不注入就没有空列可看。
 */
export async function queryAdminAgreementList(
  query: AdminAgreementListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminAgreementListData> {
  return withMockDebug(params, surface, async () => {
    if (mockEmptyApplies(params, "agreements")) {
      return { items: [], notice: ADMIN_AGREEMENT_LIST_NOTICE };
    }

    const records = await getAgreementRepository().listAgreements();

    return {
      items: sortAgreementsForAdmin(records, query.types).map(toAdminAgreementListItem),
      notice: ADMIN_AGREEMENT_LIST_NOTICE,
    };
  });
}

/**
 * 管理端协议详情（列表行 + 正文）。
 *
 * ⚠️ 编辑表单**必须**走这条路：列表行里没有正文（`AdminAgreementListItem`
 * 刻意不带 `sections`），拿列表去拼一个编辑表单只能拼出一个空正文，
 * 一保存就把用户的协议清空了。
 *
 * 找不到返回 `null`，由接口层转成 404 —— 协议不能新建也不存在「已移除」，
 * 因此「id 找不到」只可能是调用方用错了 id。
 */
export async function getAdminAgreementDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminAgreementDetail | null> {
  return withMockDebug(params, surface, async () => {
    const record = await getAgreementRepository().findAgreementById(id);
    return record ? toAdminAgreementDetail(record) : null;
  });
}

// ——————————————————————————— 写操作的公共部分 ———————————————————————————

/**
 * 幂等键。**只从请求体来**，且必须符合 `IDEMPOTENCY_KEY_PATTERN`
 * （`readIdempotencyKey()` 已经做了格式判断，非法与缺省都返回 null）。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key) {
    throw new ApiError("BAD_REQUEST", ADMIN_AGREEMENT_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

/**
 * 写上下文。
 *
 * ⚠️ 操作者的三个字段**只从这个函数的两个入参来**：`adminId` 是
 * `requireAdmin()` 返回的会话里的 `admin.id`，身份类型恒为 `admin`，
 * 名称快照本阶段为 null。**请求体里的任何 actor 字段都读不到这里**——
 * 本函数根本不接收请求体，调用方也没有别的地方可以把它塞进去（§九）。
 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return {
    actorId: adminId,
    actorRole: "admin",
    actorName: null,
    operationId,
    // 业务写入与审计写入共用这一个时间戳（理由见 `AdminWriteContext` 的注释）
    at: new Date().toISOString(),
  };
}

/**
 * 从请求体里读正文段落。
 *
 * ⚠️ 非数组一律当成空数组（→ 触发「正文至少要有一节」的校验）；
 * 数组里**非字符串的项变成空串**而不是被丢掉：丢掉会让「提交了三段、存进去两段」
 * 这种静默的数据损失发生，变成空串则会撞上「段落不能为空」的校验并被报出来。
 *
 * 这里**不做 trim**：校验与写入必须看到同一个字符串，而 trim 是
 * `normalizeAgreementProfilePatch()` 的职责（它也负责让校验看到同一个值）。
 */
function readSectionInputs(raw: unknown): AgreementSectionInput[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((item) => {
    const section =
      item && typeof item === "object" ? (item as Record<string, unknown>) : ({} as Record<string, unknown>);

    return {
      heading: typeof section.heading === "string" ? section.heading : "",
      paragraphs: Array.isArray(section.paragraphs)
        ? section.paragraphs.map((paragraph) => (typeof paragraph === "string" ? paragraph : ""))
        : [],
    };
  });
}

/**
 * 从请求体里读出一份完整的协议输入。
 *
 * ⚠️ **入参就是白名单**：`id`、`type`、`version`、`updatedAt` 在这里
 * **没有读取的位置**，客户端多传一个字段也不会有任何效果。这不是「忘了校验」，
 * 而是类型上就没有入口（§九：客户端伪造 ID、状态、时间必须被忽略）。
 *
 * `enabled` 缺省取 `true`，与类目、运营内容的编辑表单同一口径：
 * 它是一个勾选框，页面每次都会提交；缺省时按「启用」处理。
 */
function readAgreementProfileInput(body: Record<string, unknown>): AgreementProfileInput {
  return {
    title: readTrimmedString(body, "title"),
    sections: readSectionInputs(body.sections),
    enabled: readBoolean(body, "enabled", true),
  };
}

/** 逐字段校验 → 入参；任何一处不过就抛 400，message 是**第一条**错误。 */
function validateAgreement(input: AgreementProfileInput) {
  const errors = agreementProfileFieldErrors(input);
  if (hasAgreementProfileError(errors)) {
    throw new ApiError("BAD_REQUEST", firstErrorMessage(errors), 400);
  }

  const patch = normalizeAgreementProfilePatch(input);
  if (!patch) throw new ApiError("BAD_REQUEST", ADMIN_AGREEMENT_PROFILE_INVALID_MESSAGE, 400);
  return patch;
}

function firstErrorMessage(errors: Record<string, string | null>): string {
  for (const message of Object.values(errors)) {
    if (message) return message;
  }
  return ADMIN_AGREEMENT_PROFILE_INVALID_MESSAGE;
}

/**
 * 伪事务的失败 → 接口错误。
 *
 * 两种失败各有各的处置，合并成一句「操作失败」会让调用方不知道是该刷新列表，
 * 还是该换一个幂等键重试。
 *
 * ⚠️ **错误码与 HTTP 状态码一致**（`BAD_REQUEST` / 404 等），并且与类目管理
 * 用的是同一套写法：调用方只需要看 `code`。状态码不自创——
 * `ApiError` 已经按 code 给出了默认状态码，这里显式传一次只是为了让
 * 「这条失败对应哪个 HTTP 状态」在阅读时一眼可见。
 */
function toApiFailure(failure: AdminAgreementWriteFailure): ApiError {
  if (failure.kind === "not-found") {
    return new ApiError("NOT_FOUND", ADMIN_AGREEMENT_NOT_FOUND_MESSAGE, 404);
  }
  return new ApiError("BAD_REQUEST", ADMIN_AGREEMENT_OPERATION_CONFLICT_MESSAGE, 400);
}

/**
 * 伪事务结果 → 接口结果。
 *
 * 成功只回版本号、启用状态与更新时间，界面据此就地更新那一行——
 * 不必为了刷新一个开关重新拉一次列表（列表里还有另外四项协议）。
 */
function toWriteResult(outcome: AdminAgreementWriteOutcome): AdminAgreementWriteResult {
  if (outcome.kind !== "ok") throw toApiFailure(outcome);

  const { updated } = outcome.value;
  return toAdminAgreementWriteResult(updated.id, updated, outcome.changed);
}

// ——————————————————————————— 两种写操作 ———————————————————————————

/**
 * 编辑协议（标题 / 正文 / 启用状态，一次保存）。
 *
 * ⚠️ 版本号**不在入参里**：由伪事务在原子区段内按「标题或正文是否真的变了」决定
 * 是否递增。客户端传什么都没用。
 */
export async function updateAdminAgreement(
  adminId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<AdminAgreementWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const patch = validateAgreement(readAgreementProfileInput(body));

  return toWriteResult(await updateAgreement(id, patch, writeContext(adminId, operationId)));
}

/**
 * 启用 / 停用协议（窄写入）。
 *
 * ⚠️ 与 `updateAdminAgreement()` 分开：列表上的开关只应当改启用状态，
 * 而不是「读出整条记录、拼一个完整 patch 再写回去」——后者会在两位管理员
 * 同时操作时，用后写的那次把另一位刚改好的正文覆盖回旧值。
 *
 * ⚠️ 签名比任务清单里多一个 `body`：**幂等键只能从请求体来**，
 * 没有它这条路径就无法满足「同一个键第二次到达不产生第二次改动」的要求。
 * 参数顺序照抄 `setAdminCategoryEnabled(id, enabled, adminId, body)`：请求体放最后。
 */
export async function setAdminAgreementEnabled(
  adminId: string,
  id: string,
  enabled: boolean,
  body: Record<string, unknown>,
): Promise<AdminAgreementWriteResult> {
  const operationId = requireIdempotencyKey(body);

  return toWriteResult(await setAgreementEnabled(id, enabled, writeContext(adminId, operationId)));
}
