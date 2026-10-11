import type {
  CompanionApplication,
  CompanionApplicationStatus,
} from "@/lib/types/companionApplication";
import type { SupportEvidence } from "@/lib/types/evidence";
import type {
  AdminApplicationFilter,
  CompanionApplicationCreateOutcome,
  CompanionApplicationRepository,
} from "../companionApplicationRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `CompanionApplicationRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/companionApplicationRepository.ts` 里的接口
 * 一个字没改，服务层、路由、页面都不知道底下换了一个存储。
 *
 * ## 这一版真正要消灭的东西：Mock 的「读—判断—写」原子区段
 *
 * `mockCompanionApplicationRepository.createApplication` 的并发安全来自
 * 「Node 单线程 + 区段内没有 `await`」：它先查幂等键、再查这个用户有没有申请、
 * 两次都查空才写。换成数据库后同样的写法（先 `SELECT`、没有再 `INSERT`）会在两个
 * 并发提交之间留下空档 —— 两边都查到「没有」，于是同一个用户冒出两条申请。
 *
 * 这里改成**单条 `INSERT … ON CONFLICT DO NOTHING RETURNING`**：判重职责从
 * 「先读一次再决定」搬到**唯一索引**上，冲突后再回读（照抄
 * `complaintRepository.createComplaint` 的两轮收敛结构，见下）。
 *
 * ## 三重唯一性与 `createApplication` 三分支的精确映射
 *
 * 迁移 `0013_companion_onboarding.sql` 上建了三条唯一约束，它们与三分支一一对应：
 *
 * | 唯一约束 | 语义 | 冲突后回读 → 分支 |
 * |---|---|---|
 * | `companion_applications_pkey (id)` | 同一份申请不会写两遍 | 回读查不到 → 重试，仍冲突则抛错 |
 * | `companion_applications_idempotency_key (user_id, idempotency_key)` | 同一个提交意图重复到达 | `findApplicationByKey` → `idempotent` |
 * | `companion_applications_user_key (user_id)` | **一个人最多一条申请**（含已撤销） | `findApplicationByUser` → `already-applied` |
 *
 * ⚠️ **回读顺序必须与 Mock 一致**：先按「用户 + 幂等键」，命中才是 `idempotent`；
 * 查不到再按「用户」，命中是 `already-applied`。两处的顺序写反，会把「同一次提交
 * 重试」误判成「已经有了别的申请」，用户看到的是「你已有一条入驻申请」而不是上次的结果。
 *
 * ⚠️ `user_id` 是**全局**唯一、**不加** `WHERE status <> 'withdrawn'`：Mock 的
 * `applicationIdByUser` 在撤销时**不删键**，因此「撤销后重新申请」走的是**同一条记录**
 * 的状态回迁，而不是新建第二条。这条口径由索引与回读顺序共同守住。
 *
 * ## 时间与 JSON
 *
 * `submitted_at` / `updated_at` / `reviewed_at` 是 `timestamptz`，经 `pool.ts` 的
 * 解析器钩子统一还原成 ISO 字符串或 `null`，领域对象上的时间字段因此仍是 `string`。
 * `game_ids` / `regions` / `service_tags` / `evidence` 是 `jsonb`，驱动**直接返回已解析
 * 的 JS 数组**，映射时直接赋值，**不做 `JSON.parse`**；写入时 `JSON.stringify`。
 *
 * ## 排序必须完全确定
 *
 * Mock 用稳定排序的 JS `Array.prototype.sort`（`compareApplicationsForAdmin`），
 * SQL 的 `ORDER BY` 不是稳定排序。后台列表因此显式写出两级
 * `submitted_at DESC, id ASC`，少写 `id` 兜底，同一条申请可能在第一页出现过、
 * 翻到第二页又出现一次。
 */

type CompanionApplicationRow = {
  id: string;
  application_no: string;
  user_id: string;
  display_name: string;
  /** jsonb：驱动已解析成数组，直接取值。 */
  game_ids: string[];
  regions: string[];
  service_tags: string[];
  experience: string;
  introduction: string;
  contact_note: string;
  /** jsonb：`SupportEvidence[]`，驱动已解析。 */
  evidence: SupportEvidence[];
  status: CompanionApplicationStatus;
  submitted_at: string;
  updated_at: string;
  reviewed_at: string | null;
  review_note: string;
};

/**
 * 领域对象会读到的列。
 *
 * ⚠️ **不含 `idempotency_key`**：它不是实体字段，Mock 里只活在 `applicationIdByKey`
 * 索引上（见 `mockCompanionApplicationRepository.ts`）。
 */
const COLUMNS =
  "id, application_no, user_id, display_name, game_ids, regions, service_tags, " +
  "experience, introduction, contact_note, evidence, status, submitted_at, " +
  "updated_at, reviewed_at, review_note";

/** 写入侧的列：相比 `COLUMNS` 多一个幂等键。 */
const INSERT_COLUMNS = `${COLUMNS}, idempotency_key`;

const INSERT_VALUE_COUNT = 17;

function toCompanionApplication(row: CompanionApplicationRow): CompanionApplication {
  return {
    id: row.id,
    applicationNo: row.application_no,
    userId: row.user_id,
    displayName: row.display_name,
    // jsonb 已由驱动解析，直接赋值
    gameIds: row.game_ids,
    regions: row.regions,
    serviceTags: row.service_tags,
    experience: row.experience,
    introduction: row.introduction,
    contactNote: row.contact_note,
    evidence: row.evidence,
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
  };
}

/**
 * jsonb 列的入参。四个 jsonb 列都是 NOT NULL 数组，这里仍保持与
 * `complaintRepository.ts` / `refundRepository.ts` 同形的 `null` 透传：
 * `null` 原样交给驱动，不做 `JSON.stringify(null)`（那会变成字符串 `"null"`）。
 */
function jsonbParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * 取值顺序**必须**与 `INSERT_COLUMNS` 逐位对应。
 *
 * ⚠️ `idempotencyKey` 在 `INSERT_COLUMNS` 里是**最后一个**（`COLUMNS` 的 16 列之后），
 * 因此这里也必须放最后。写成中间某个位置不会在类型上暴露 —— PG 运行时会把字符串
 * 往错位的列里塞并抛错，而**只比读的契约测试看不见**。
 */
function insertValues(
  application: CompanionApplication,
  idempotencyKey: string,
): unknown[] {
  return [
    application.id,
    application.applicationNo,
    application.userId,
    application.displayName,
    jsonbParam(application.gameIds),
    jsonbParam(application.regions),
    jsonbParam(application.serviceTags),
    application.experience,
    application.introduction,
    application.contactNote,
    jsonbParam(application.evidence),
    application.status,
    application.submittedAt,
    application.updatedAt,
    application.reviewedAt,
    application.reviewNote,
    idempotencyKey,
  ];
}

/**
 * 用任意可执行 SQL 的对象造一个入驻申请仓储。
 *
 * 与投诉 / 退款同构：**一个工厂同时产出普通仓储与事务内仓储**。将来「审核通过」
 * 要在一段事务里同时写「申请 + 资格 + 护航 + 审计」，把 `withTransaction` 给出的
 * `TxHandle` 传进来即可，调用方不需要换一套 API。
 */
export function createCompanionApplicationRepository(
  db: PgQueryable,
): CompanionApplicationRepository {
  /** 「一个人最多一条」的读取侧入口。唯一索引保证最多一行，不需要排序。 */
  async function findApplicationByUser(userId: string): Promise<CompanionApplication | null> {
    const rows = await db.query<CompanionApplicationRow>(
      `SELECT ${COLUMNS} FROM companion_applications WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ? toCompanionApplication(rows[0]) : null;
  }

  /** 按「用户 + 幂等键」查。`idempotency_key = $2` 永远匹配不到 NULL，预置数据与 Mock 一致。 */
  async function findApplicationByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<CompanionApplication | null> {
    const rows = await db.query<CompanionApplicationRow>(
      `SELECT ${COLUMNS} FROM companion_applications
        WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return rows[0] ? toCompanionApplication(rows[0]) : null;
  }

  return {
    findApplicationByUser,

    async findApplicationById(id) {
      // 不过滤归属：归属由服务层用 `findApplicationById` 的返回值自行校验（与 Mock 同）。
      const rows = await db.query<CompanionApplicationRow>(
        `SELECT ${COLUMNS} FROM companion_applications WHERE id = $1`,
        [id],
      );
      return rows[0] ? toCompanionApplication(rows[0]) : null;
    },

    async countApplicationsByStatus() {
      // 一次 `GROUP BY` 拿到全部有记录的状态；缺的状态在下面补 0 —— 概览要的是
      // 固定五个数字，不是「查询里有几行」。计数交给数据库，不把正文取回来。
      const rows = await db.query<{ status: CompanionApplicationStatus; total: number }>(
        `SELECT status, count(*)::int AS total
           FROM companion_applications
          GROUP BY status`,
      );

      // 显式写出五个状态：将来新增状态时 `Record` 会编译报错，
      // 而不是让概览悄悄少一个数（与 Mock 同构造）。
      const counts: Record<CompanionApplicationStatus, number> = {
        pending: 0,
        reviewing: 0,
        approved: 0,
        rejected: 0,
        withdrawn: 0,
      };
      for (const row of rows) counts[row.status] = row.total;
      return counts;
    },

    async queryApplicationsForAdmin(filter: AdminApplicationFilter) {
      const { statuses } = filter;
      const conditions: string[] = [];
      const params: unknown[] = [];

      // 状态：`null` = 不限（不拼接任何条件）；数组 = 命中集合。
      // ⚠️ 空数组 = `status = ANY('{}')` = 一条都不命中，与 Mock 的 `includes()` 恒假一致，
      //    这与 `null` 的「不限」是两件事，不在这里替调用方合并。
      if (statuses !== null) {
        params.push([...statuses]);
        conditions.push(`status = ANY($${params.length}::text[])`);
      }

      // 游戏：空串 = 全部游戏；否则要求 `game_ids` 这个 jsonb 数组**包含**该 id。
      // `?` 是 jsonb 的「顶层键 / 元素存在」运算符，与护航公开列表同口径。
      if (filter.gameId) {
        params.push(filter.gameId);
        conditions.push(`game_ids ? $${params.length}`);
      }

      // 关键词：只比对**申请单号**与**陪玩昵称**两处（`applicationMatchesAdminKeyword`），
      // 正文不参与搜索。空串（含纯空白）不搜索，与 Mock 的提前 `return true` 一致。
      // ⚠️ 用 `strpos` 而不是 `LIKE`：Mock 是纯子串包含，`LIKE` 会把关键词里的
      //    `%` / `_` 当通配符。关键词先 `trim` 再去 `lower`，与 Mock 的
      //    `keyword.trim().toLowerCase()` 逐字段对齐。
      const keyword = filter.keyword.trim();
      if (keyword) {
        params.push(keyword.toLowerCase());
        const needle = `$${params.length}`;
        conditions.push(
          `(strpos(lower(application_no), ${needle}) > 0
            OR strpos(lower(display_name), ${needle}) > 0)`,
        );
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // 与 `compareApplicationsForAdmin` 对齐：提交时间倒序，相等时按 **id 升序** 兜底。
      // 两级都写出来，分页才不会让同一条申请在两页里各出现一次。
      const rows = await db.query<CompanionApplicationRow>(
        `SELECT ${COLUMNS} FROM companion_applications
          ${where}
          ORDER BY submitted_at DESC, id ASC`,
        params,
      );
      return rows.map(toCompanionApplication);
    },

    findApplicationByKey,

    async createApplication(application, idempotencyKey): Promise<CompanionApplicationCreateOutcome> {
      const placeholders = Array.from(
        { length: INSERT_VALUE_COUNT },
        (_, index) => `$${index + 1}`,
      ).join(", ");
      const values = insertValues(application, idempotencyKey);

      // 最多两轮：第二轮只在「冲突命中后、读回之前，那行被并发删掉」时发生。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<CompanionApplicationRow>(
          `INSERT INTO companion_applications (${INSERT_COLUMNS})
           VALUES (${placeholders})
           ON CONFLICT DO NOTHING
           RETURNING ${COLUMNS}`,
          values,
        );
        // 写进去了：这就是 `created`。返回**库里的那一行**（不是入参对象），
        // 保证时间戳经过驱动归一化后的值与后续读取逐字段相同。
        if (inserted[0]) {
          return { kind: "created", application: toCompanionApplication(inserted[0]) };
        }

        // ① 先按幂等键回读 —— 优先级与 Mock 相同，命中即「同一次提交意图重试」。
        const byKey = await findApplicationByKey(application.userId, idempotencyKey);
        if (byKey) return { kind: "idempotent", application: byKey };

        // ② 再按用户回读 —— 「一个人最多一条」，换一个幂等键也写不进第二条。
        //    返回的是**既有那条**（可以是任何状态，包括已撤销）。
        const byUser = await findApplicationByUser(application.userId);
        if (byUser) return { kind: "already-applied", application: byUser };

        // 走到这里说明既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `入驻申请写入在并发下未能收敛（用户 ${application.userId} / 幂等键 ${idempotencyKey}）。`,
      );
    },

    async withdrawApplication(id, at) {
      // 一条语句完成「状态判定 + 写入」：`WHERE status = 'pending'` 与 UPDATE 同处一句，
      // 因此不存在「先查到是 pending、写之前状态被审核改掉」的窗口。
      // 只改状态与四个派生字段，**不删除记录** —— 用户仍要能在进度页看到自己提交过什么。
      // `reviewed_at = NULL` / `review_note = ''` 与 Mock 逐字段一致：撤销不产生审核结果。
      const updated = await db.query<CompanionApplicationRow>(
        `UPDATE companion_applications
            SET status = 'withdrawn',
                updated_at = $2,
                reviewed_at = NULL,
                review_note = ''
          WHERE id = $1 AND status = 'pending'
          RETURNING ${COLUMNS}`,
        [id, at],
      );
      if (updated[0]) {
        return { application: toCompanionApplication(updated[0]), withdrawn: true };
      }

      // 没更新到行：区分「已经是已撤销」（重复撤销应当幂等成功）与
      // 「其它状态 / 不存在」（返回 null，由服务层转成业务错误）。
      // 这次读取**只用于诊断**，不参与任何写入决策。
      const found = await db.query<CompanionApplicationRow>(
        `SELECT ${COLUMNS} FROM companion_applications WHERE id = $1`,
        [id],
      );
      if (found[0] && found[0].status === "withdrawn") {
        return { application: toCompanionApplication(found[0]), withdrawn: false };
      }
      return null;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgCompanionApplicationRepository: CompanionApplicationRepository =
  createCompanionApplicationRepository(lazyPgExecutor());
