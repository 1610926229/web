import { ApiError } from "@/lib/api/ApiError";
import {
  COMPANION_APPLICATION_EXISTS_MESSAGE,
  COMPANION_APPLICATION_EVIDENCE_KINDS,
  COMPANION_APPLICATION_EVIDENCE_MAX_COUNT,
  COMPANION_APPLICATION_GAME_INVALID_MESSAGE,
  COMPANION_APPLICATION_GAME_REQUIRED_MESSAGE,
  COMPANION_APPLICATION_REGION_INVALID_MESSAGE,
  COMPANION_APPLICATION_REGION_REQUIRED_MESSAGE,
  COMPANION_APPLICATION_STATUS_LABELS,
  COMPANION_APPLICATION_TAG_INVALID_MESSAGE,
  COMPANION_APPLICATION_TAG_REQUIRED_MESSAGE,
  COMPANION_SERVICE_TAGS,
  canWithdrawCompanionApplication,
  normalizeCompanionApplicationContactNote,
  normalizeCompanionApplicationExperience,
  normalizeCompanionApplicationIntroduction,
  normalizeCompanionApplicationName,
  toCompanionApplicationDetail,
} from "@/lib/constants/companionApplications";
import { parseEvidenceInput, toStoredEvidence, type EvidenceDraft } from "@/lib/constants/evidence";
import {
  IDEMPOTENCY_KEY_MISSING_MESSAGE,
  readIdempotencyKey,
  readTrimmedString,
} from "@/lib/constants/writes";
import { getCompanionApplicationRepository } from "@/lib/data/companionApplicationRepository";
import { getDataSource } from "@/lib/data/source";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  CompanionApplication,
  CompanionApplicationCreateResult,
  CompanionApplicationDetail,
  CompanionApplicationGameOption,
  CompanionApplicationSummary,
  CompanionApplicationWithdrawResult,
} from "@/lib/types/companionApplication";

/**
 * 护航入驻申请服务 —— 提交表单、进度页与接口共用的唯一入口。
 *
 * 五条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只处理当前用户的数据**。所有函数都要求传入会话里读到的 `userId`，
 *    仓储把它当成查询条件；接口不接受任何「查谁的申请」参数。
 * 2. **身份、单号、状态与时间一律由服务端写**。请求体只按白名单取
 *    「昵称 / 游戏 / 大区 / 服务标签 / 经验 / 自我介绍 / 联系说明 / 凭证」，
 *    客户端塞进来的 `userId` / `applicationNo` / `status` / `reviewedAt` /
 *    `reviewNote` / `submittedAt` 都不会被读取——不是「检查一下对不对」，
 *    而是根本不存在接收这些字段的位置。
 * 3. **用户能造出来的状态只有两种**：提交产生 `pending`，撤销产生 `withdrawn`。
 *    本文件里没有任何把状态改成 `reviewing` / `approved` / `rejected` 的路径。
 * 4. **一个人最多一条申请**。幂等键挡住「同一次提交意图重复到达」，
 *    「已有申请」规则挡住「换一个键再提交一次」；后者在仓储的原子区段里再挡一次，
 *    因此并发请求也只会留下一条。
 * 5. **申请不改动任何业务数据**。这里不写订单、不写支付、不改用户角色、
 *    不创建陪玩公开资料——通过申请与「成为护航」之间的关系尚未确认。
 */

/** 申请单号：`RA` + 日期 + 六位随机尾号。与退款单号同一套生成方式。 */
function makeApplicationNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const tail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `RA${stamp}${tail}`;
}

function readStringArray(body: Record<string, unknown>, key: string): string[] {
  const raw = body[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** 昵称 / 经验 / 自我介绍 / 联系说明：四项文本字段的解析与校验。 */
type ApplicationText = {
  displayName: string;
  experience: string;
  introduction: string;
  contactNote: string;
};

function parseApplicationText(body: Record<string, unknown>): ApplicationText {
  const name = normalizeCompanionApplicationName(readTrimmedString(body, "displayName"));
  if (!name.ok) throw new ApiError("BAD_REQUEST", name.message);

  const experience = normalizeCompanionApplicationExperience(readTrimmedString(body, "experience"));
  if (!experience.ok) throw new ApiError("BAD_REQUEST", experience.message);

  const introduction = normalizeCompanionApplicationIntroduction(
    typeof body.introduction === "string" ? body.introduction : "",
  );
  if (!introduction.ok) throw new ApiError("BAD_REQUEST", introduction.message);

  const contactNote = normalizeCompanionApplicationContactNote(
    typeof body.contactNote === "string" ? body.contactNote : "",
  );
  if (!contactNote.ok) throw new ApiError("BAD_REQUEST", contactNote.message);

  return {
    displayName: name.value,
    experience: experience.value,
    introduction: introduction.value,
    contactNote: contactNote.value,
  };
}

/**
 * 游戏 / 大区 / 服务标签。
 *
 * 三件事都在这里校验，且**都对着真实数据校验**：
 * - 游戏必须存在于游戏目录（不是在页面里写死一份列表）；
 * - 大区必须属于**所选游戏之一**——选了三角洲行动却填无畏契约的大区，
 *   在详情页上就是一条无法解释的数据；
 * - 服务标签必须来自目录，避免出现「页面上根本没有的标签」。
 *
 * 重复项静默去重：用户多点一下不该变成一条错误，而去重后为空才报「请至少选一个」。
 */
async function parseApplicationTargets(body: Record<string, unknown>): Promise<{
  gameIds: string[];
  regions: string[];
  serviceTags: string[];
}> {
  const games = await getDataSource().getGames();
  const knownGameIds = new Set(games.map((game) => game.id));

  const gameIds = dedupe(readStringArray(body, "gameIds"));
  if (gameIds.length === 0) {
    throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_GAME_REQUIRED_MESSAGE);
  }
  for (const gameId of gameIds) {
    if (!knownGameIds.has(gameId)) {
      throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_GAME_INVALID_MESSAGE);
    }
  }

  const allowedRegions = new Set(
    games.filter((game) => gameIds.includes(game.id)).flatMap((game) => game.regions),
  );
  const regions = dedupe(readStringArray(body, "regions"));
  if (regions.length === 0) {
    throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_REGION_REQUIRED_MESSAGE);
  }
  for (const region of regions) {
    if (!allowedRegions.has(region)) {
      throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_REGION_INVALID_MESSAGE);
    }
  }

  const serviceTags = dedupe(readStringArray(body, "serviceTags"));
  if (serviceTags.length === 0) {
    throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_TAG_REQUIRED_MESSAGE);
  }
  for (const tag of serviceTags) {
    if (!COMPANION_SERVICE_TAGS.includes(tag)) {
      throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_TAG_INVALID_MESSAGE);
    }
  }

  return { gameIds, regions, serviceTags };
}

// ——————————————————————————— 表单选项 ———————————————————————————

/**
 * 「擅长游戏」与「可服务大区」的可选项。
 *
 * 取自**真实游戏目录**，不在页面里写死一份：写死的那一份迟早会与服务端校验用的
 * 目录分叉，表现就是「选得到的游戏提交后被拒」。
 *
 * 大区跟着游戏走（`game.regions`），因此服务端「大区必须属于所选游戏」这条校验，
 * 在表单这一层是不可能被违反的——除非有人绕开页面直接提交。
 */
export async function listCompanionApplicationGameOptions(): Promise<
  CompanionApplicationGameOption[]
> {
  const games = await getDataSource().getGames();
  return games.map((game) => ({ id: game.id, name: game.name, regions: [...game.regions] }));
}

// ——————————————————————————— 读取 ———————————————————————————

async function gameNameById(): Promise<Record<string, string>> {
  const games = await getDataSource().getGames();
  return Object.fromEntries(games.map((game) => [game.id, game.name]));
}

/**
 * 当前用户的申请摘要（**只有状态、单号与时间**）。
 *
 * 给 `/join` 用：这一页只需要知道「已经有一条申请了，处于哪个状态」，
 * 表单内容与凭证都不该被读到这一页来。没有申请返回 null——**这不是错误**，
 * 「还没有申请」是正常状态，因此不抛异常、也不用 404 表达。
 */
export async function getMyCompanionApplicationSummary(
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<CompanionApplicationSummary | null> {
  return withMockDebug(params, surface, async () => {
    const application = await getCompanionApplicationRepository().findApplicationByUser(userId);
    return application ? toSummary(application) : null;
  });
}

/**
 * 当前用户的申请详情（进度页与 `GET /api/me/companion-application`）。
 *
 * 没有申请返回 null：接口据此返回 `{ application: null }`，
 * 页面据此显示「还没有申请」并给出回到 `/join` 的入口——两种情况都不用 404，
 * 「没申请过」本来就是最常见的一种正常状态。
 */
export async function getMyCompanionApplicationDetail(
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<CompanionApplicationDetail | null> {
  return withMockDebug(params, surface, async () => {
    const application = await getCompanionApplicationRepository().findApplicationByUser(userId);
    if (!application) return null;

    return toCompanionApplicationDetail(application, await gameNameById());
  });
}

function toSummary(application: CompanionApplication): CompanionApplicationSummary {
  return {
    id: application.id,
    applicationNo: application.applicationNo,
    status: application.status,
    statusLabel: COMPANION_APPLICATION_STATUS_LABELS[application.status],
    submittedAt: application.submittedAt,
    updatedAt: application.updatedAt,
  };
}

// ——————————————————————————— 提交 ———————————————————————————

/**
 * 提交入驻申请。
 *
 * 顺序刻意如此：
 *
 * 1. 幂等键格式不对直接拒绝——没有键就无法防重，宁可不做；
 * 2. **快速路径**：这个键提交过就返回上一次的结果，连校验都不重来
 *    （重试要的是「和上次一样的结果」，而不是按现在的状态重新算一遍）；
 * 3. **已有申请**：这是整个操作的前提，不是某一项填错了。放在字段校验之前，
 *    调用方拿到的是「你已经申请过了」这个真正可执行的答案，
 *    而不是先去修一堆再也不会被用到的字段；
 * 4. 白名单解析并逐项校验（文本长度、游戏 / 大区 / 标签取值、凭证）；
 * 5. 写入：id、单号、状态（`pending`）、提交时间全部由服务端生成，
 *    审核时间与审核备注留空。
 */
export async function createCompanionApplicationForUser(
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<CompanionApplicationCreateResult> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const repository = getCompanionApplicationRepository();

  const byKey = await repository.findApplicationByKey(userId, idempotencyKey);
  if (byKey) {
    return {
      applicationId: byKey.id,
      applicationNo: byKey.applicationNo,
      status: byKey.status,
      created: false,
    };
  }

  const existing = await repository.findApplicationByUser(userId);
  if (existing) throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_EXISTS_MESSAGE, 400);

  const text = parseApplicationText(body);
  const targets = await parseApplicationTargets(body);

  const evidence = parseEvidenceInput(
    body.evidence,
    COMPANION_APPLICATION_EVIDENCE_MAX_COUNT,
    COMPANION_APPLICATION_EVIDENCE_KINDS,
  );
  if (!evidence.ok) throw new ApiError("BAD_REQUEST", evidence.message);

  const submittedAt = now.toISOString();

  const outcome = await withMockDebug(params, surface, () =>
    repository.createApplication(
      {
        id: `ca_${crypto.randomUUID()}`,
        applicationNo: makeApplicationNo(now),
        userId,

        displayName: text.displayName,
        gameIds: targets.gameIds,
        regions: targets.regions,
        serviceTags: targets.serviceTags,
        experience: text.experience,
        introduction: text.introduction,
        contactNote: text.contactNote,
        // 凭证的 id 与地址在这里生成，客户端只提交了类型与文件名
        evidence: toStoredEvidence(evidence.items as EvidenceDraft[]),

        // 用户新提交的申请只会是「待查看」：本阶段没有任何用户端的审核入口
        status: "pending",
        submittedAt,
        updatedAt: submittedAt,
        reviewedAt: null,
        reviewNote: "",
      },
      idempotencyKey,
    ),
  );

  // 被「一个人最多一条」挡住：这里才可能出现（上面的检查与写入之间隔着对游戏目录的 await）
  if (outcome.kind === "already-applied") {
    throw new ApiError("BAD_REQUEST", COMPANION_APPLICATION_EXISTS_MESSAGE, 400);
  }

  return {
    applicationId: outcome.application.id,
    applicationNo: outcome.application.applicationNo,
    status: outcome.application.status,
    created: outcome.kind === "created",
  };
}

// ——————————————————————————— 撤销 ———————————————————————————

/**
 * 撤销入驻申请。
 *
 * 四条规则：
 * - **只有本人**：申请不存在、或不属于当前用户，**一律返回同一个 404**
 *   （`null` 由接口转成 `NOT_FOUND`）。两种情况对外表现完全相同，
 *   因此拿别人的申请 id 来试探得不到任何信息；
 * - **只有「待查看」可以撤销**：`reviewing` / `approved` / `rejected` / `withdrawn`
 *   都不可以，返回 `BAD_REQUEST`；
 * - **重复撤销是幂等的**：已经是「已撤销」时返回同一条记录、`withdrawn` 为 false，
 *   不会再产生一次变更；
 * - **只改状态，不删除记录**：用户仍然要能在进度页看到自己提交过什么。
 */
export async function withdrawCompanionApplicationForUser(
  userId: string,
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<CompanionApplicationWithdrawResult> {
  return withMockDebug(params, surface, async () => {
    const repository = getCompanionApplicationRepository();

    const application = await repository.findApplicationById(id);
    // 不存在与不属于本人走同一个分支：对外都是同一个 404，不给出「存在但不是你的」这种区分
    if (!application || application.userId !== userId) {
      throw new ApiError("NOT_FOUND", "入驻申请不存在", 404);
    }

    if (!canWithdrawCompanionApplication(application.status)) {
      // 已经是「已撤销」的不算错误：重复撤销应当幂等成功
      if (application.status === "withdrawn") {
        return { applicationId: application.id, status: application.status, withdrawn: false };
      }
      throw new ApiError(
        "BAD_REQUEST",
        `当前状态为「${COMPANION_APPLICATION_STATUS_LABELS[application.status]}」，不能撤销`,
        400,
      );
    }

    const outcome = await repository.withdrawApplication(id, now.toISOString());
    if (!outcome) {
      // 读取与写入之间状态被改过（本阶段没有别的入口，属于兜底）
      throw new ApiError("BAD_REQUEST", "当前状态不能撤销", 400);
    }

    return {
      applicationId: outcome.application.id,
      status: outcome.application.status,
      withdrawn: outcome.withdrawn,
    };
  });
}
