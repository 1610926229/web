import type { Agreement, AgreementSection } from "@/lib/types/agreement";
import type {
  AgreementPatch,
  AgreementRepository,
  AgreementWriteResult,
} from "../agreementRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `AgreementRepository` 的 PostgreSQL 实现（协议与版本介绍）。
 *
 * ## 为什么要有这一份
 *
 * PROD-1E Phase 1 要把协议正文的真值从 `globalThis` Mock store 搬到 PostgreSQL。
 * 用户端协议页与管理后台读的是同一个接口，`lib/data/agreementRepository.ts`
 * 一个字都不改——两个实现在同一份输入下必须给出逐字段相同的输出
 * （Phase 4：Mock 行为是迁移的语义基线）。
 *
 * ## 只有两个写方法，没有 create / remove
 *
 * 协议类型是固定枚举，每个类型可以有**多个版本**（`agreementSeed` 里 `user` 与
 * `platform` 各有两条，`pickCurrentAgreements()` 只挑启用中版本号最高的一条）。
 * 因此数据库里**没有** `UNIQUE (type)`，真正的自然键是 `(type, version)`
 * （`db/migrations/0012_operations_content.sql` 的 `agreements_type_version_key`）。
 * 「下架一份协议」是把它停用（可逆），不是删记录——所以这张表也没有 `markRemoved`。
 *
 * ## 排序：与 Mock 逐条对齐
 *
 * `listAgreements()` 在 Mock 里是「遍历 Map 的插入顺序」，接口注释写明
 * 「顺序不做保证」。SQL 表是无序集合，不补排序则两次查询顺序可能不同，
 * 因此这里补 `ORDER BY id`（主键天然唯一，是最稳的兜底），
 * 与 `pgCompanionRepository.listCompanions()` / `pgContentRepository` 同一取舍。
 * 「哪一版是当前版本」的业务规则在纯函数 `pickCurrentAgreements()` 里，不在这里。
 *
 * ## 时间与 JSON
 *
 * `updated_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串，
 * 因此 `Agreement.updatedAt` 仍然是 `string`（与 Mock 一致）。
 * `sections` 是 `jsonb`：**读取时驱动直接返回已解析的数组，不做 `JSON.parse`**；
 * 写入时用 `JSON.stringify` 序列化。
 *
 * ## version 由调用方算好，仓储不递增
 *
 * `patch.version` 已经是**算好的值**（`bumpAgreementVersion()` 在服务端事务里算，
 * 且只在标题或正文真的变了时才推进）。仓储自己去 bump 的话，一次「内容没改」的保存
 * 也会把版本推高一格。`type` 与 `id` 是记录身份，**不在 patch 里**，这里也不写。
 */

type AgreementRow = {
  id: string;
  /** 固定枚举，DDL 有 `agreements_type_check` 兜底。 */
  type: Agreement["type"];
  title: string;
  /** jsonb：驱动已解析成 `AgreementSection[]`，直接取值。 */
  sections: AgreementSection[];
  version: string;
  updated_at: string;
  enabled: boolean;
};

/** 列清单。`id` 定义在 `COLLATE "C"` 上，`ORDER BY id` 因此是字节序、跨环境一致。 */
const COLUMNS = "id, type, title, sections, version, updated_at, enabled";

/**
 * 段落深拷贝。
 *
 * `sections` 是二维结构，复制时必须**连段落数组再复制一层**：只复制外层的话，
 * 调用方改一段正文会写进仓储返回的那一份（Mock 的 `cloneSections()` 同一条理由）。
 * 同一行被映射两次时（`setAgreementEnabled` 的幂等分支）也必须得到两份**互相独立**
 * 的 `sections`，否则 `previous` 与 `updated` 会共享同一个数组。
 *
 * ⚠️ 刻意**不**从 `mockAgreementRepository` 引入 `cloneSections`：Pg 实现不在运行时
 * 依赖 Mock persistence（PROD-1E Phase 11：`DATA_SOURCE=postgres` 时核心业务链
 * 不得依赖 Mock）。这里只是把「一段协议正文的拷贝是什么意思」按同一个形状写一遍。
 */
function cloneSections(sections: readonly AgreementSection[]): AgreementSection[] {
  return sections.map((section) => ({
    heading: section.heading,
    paragraphs: [...section.paragraphs],
  }));
}

function toAgreement(row: AgreementRow): Agreement {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    // jsonb 已由驱动解析，直接取用后再复制一层，保证返回对象之间互不影响
    sections: cloneSections(row.sections),
    version: row.version,
    updatedAt: row.updated_at,
    enabled: row.enabled,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个协议仓储。
 *
 * 与其它 Pg 仓储同构：**一个工厂同时产出普通仓储与事务内仓储**。传
 * `withTransaction` 给出的 `TxHandle` 进来，就能让这些读写与同一事务里的
 * 审计写入共享同一条连接、同一个提交点；接口完全一样，调用方不必换 API。
 */
export function createAgreementRepository(db: PgQueryable): AgreementRepository {
  return {
    async listAgreements() {
      // `ORDER BY id` 是确定性的兜底：Mock 是 Map 插入顺序，SQL 表没有那层含义。
      // 不做任何过滤（含停用与历史版本），与 Mock 的 `[...map.values()]` 对齐。
      const rows = await db.query<AgreementRow>(`SELECT ${COLUMNS} FROM agreements ORDER BY id`);
      return rows.map(toAgreement);
    },

    async findAgreementById(id) {
      // `WHERE id = $1`：按主键精确命中，**含已停用的**（与 Mock 的 map.get 对齐）。
      // 用户端从不按 id 取协议，它拿的是 buildAgreementsDto() 组装好的当前启用版本。
      const rows = await db.query<AgreementRow>(
        `SELECT ${COLUMNS} FROM agreements WHERE id = $1`,
        [id],
      );
      return rows[0] ? toAgreement(rows[0]) : null;
    },

    async updateAgreement(id, patch: AgreementPatch): Promise<AgreementWriteResult | null> {
      // `previous` 必须在 UPDATE **之前**读出来：写完之后再读，读到的已经是新值，
      // 而审计快照的 before 要回答的是「改动前是什么」。
      const existing = await db.query<AgreementRow>(
        `SELECT ${COLUMNS} FROM agreements WHERE id = $1`,
        [id],
      );
      if (!existing[0]) return null;
      const previous = toAgreement(existing[0]);

      // 覆盖式更新**五个可编辑列**（与 Mock 的 `updateAgreement` 逐字段对齐）：
      // title / sections / version / updated_at / enabled。
      // `id` 与 `type` 不写：它们是记录的身份，改类型等于换了一份协议，不是编辑。
      // sections 是 jsonb，用 JSON.stringify 序列化（`null` 由类型排除：NOT NULL）。
      const rows = await db.query<AgreementRow>(
        `UPDATE agreements
            SET title = $2,
                sections = $3,
                version = $4,
                updated_at = $5,
                enabled = $6
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [id, patch.title, JSON.stringify(patch.sections), patch.version, patch.at, patch.enabled],
      );
      // 行在「读」与「写」之间被并发删掉：Mock 里不存在这种状态，这里返回 null。
      // ⚠️ 这也说明本方法不是单语句原子——并发正确性由上层事务持有行锁后调用保证。
      if (!rows[0]) return null;
      return { previous, updated: toAgreement(rows[0]) };
    },

    async setAgreementEnabled(id, enabled, at): Promise<AgreementWriteResult | null> {
      const existing = await db.query<AgreementRow>(
        `SELECT ${COLUMNS} FROM agreements WHERE id = $1`,
        [id],
      );
      if (!existing[0]) return null;

      // 幂等：已经是目标状态时**不写库、不刷新 updated_at**，原样返回两份
      // **值相等但互相独立**的副本（Mock 返回两个各自 cloneAgreement 的副本）。
      // ⚠️ 这条路径**不动 version**：启用状态不是正文的版本。
      if (existing[0].enabled === enabled) {
        const row = existing[0];
        return { previous: toAgreement(row), updated: toAgreement(row) };
      }

      const previous = toAgreement(existing[0]);
      // `WHERE id = $1`：主键精确命中；只写 enabled 与 updated_at 两列，version 原样保留
      const rows = await db.query<AgreementRow>(
        `UPDATE agreements SET enabled = $2, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, enabled, at],
      );
      if (!rows[0]) return null;
      return { previous, updated: toAgreement(rows[0]) };
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgAgreementRepository: AgreementRepository = createAgreementRepository(lazyPgExecutor());
