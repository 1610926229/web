import type {
  QualificationRepository,
  UserQualificationRecord,
  UserQualificationRole,
} from "../qualificationRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `QualificationRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/qualificationRepository.ts` 里的接口
 * 一个字没改，服务层、路由、页面都不知道底下换了一个存储。
 *
 * ## 这一版没有要消灭的原子区段
 *
 * 本接口**只有三个读方法**。资格的发放是一个**同步写入原语**
 * （Mock 侧 `grantQualificationRecord`），它与「申请状态 + 护航资料 + 审计」
 * 一起写在管理端审核通过的那段事务里 —— 那属于管理端写事务，不在本文件里实现。
 *
 * ## 主键即唯一性
 *
 * 表 `user_qualifications` 没有单列 `id`：自然键 `(user_id, role)` 就是主键
 * （迁移 `0013_companion_onboarding.sql`）。「老板」（`consumer`）是默认身份，
 * **不在这个表里** —— 它是「没有记录」的含义，`role` 的取值由 CHECK 限制为 `companion`。
 *
 * ## 时间映射
 *
 * `granted_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串，
 * 因此 `UserQualificationRecord.grantedAt` 仍是 `string`，与 Mock 完全一致。
 *
 * ## 排序是显式补上的，且只补「确定性」
 *
 * Mock 的列表读是「遍历 Map 的插入顺序」，SQL 里没有那个定义。本接口**没有**定义
 * 任何业务顺序（只有一个 `role` 取值，列表长度至多为 1），因此这里只保证**确定性**：
 * 按自然键 `(user_id, role)` 升序。这样同一份数据两次查询顺序一致，
 * 需要「按内容比较」的契约测试也拿得到一个稳定次序。
 */

type UserQualificationRow = {
  user_id: string;
  role: UserQualificationRole;
  companion_id: string;
  application_id: string;
  granted_at: string;
  granted_by_admin_id: string;
};

/** 列清单的读取顺序，与 `UserQualificationRow` 逐字段对应。 */
const COLUMNS = "user_id, role, companion_id, application_id, granted_at, granted_by_admin_id";

function toQualification(row: UserQualificationRow): UserQualificationRecord {
  return {
    userId: row.user_id,
    role: row.role,
    companionId: row.companion_id,
    applicationId: row.application_id,
    grantedAt: row.granted_at,
    grantedByAdminId: row.granted_by_admin_id,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个资格仓储。
 *
 * 与其它仓储同构：**一个工厂同时产出普通仓储与事务内仓储**。
 */
export function createQualificationRepository(db: PgQueryable): QualificationRepository {
  return {
    async findQualification(userId, role) {
      // 主键 `(user_id, role)` 至多命中一行，不需要排序。
      const rows = await db.query<UserQualificationRow>(
        `SELECT ${COLUMNS} FROM user_qualifications
          WHERE user_id = $1 AND role = $2`,
        [userId, role],
      );
      return rows[0] ? toQualification(rows[0]) : null;
    },

    async listQualificationsByUser(userId) {
      // 固定用户时主键的第二个分量 `role` 就是完整全序：本阶段至多一行，
      // 将来加第二个资格时顺序也确定（`role` 升序），不会随物理存储漂移。
      const rows = await db.query<UserQualificationRow>(
        `SELECT ${COLUMNS} FROM user_qualifications
          WHERE user_id = $1
          ORDER BY role ASC`,
        [userId],
      );
      return rows.map(toQualification);
    },

    async listQualifications() {
      // 全量：按自然键 `(user_id, role)` 升序，给出一个与物理存储无关的稳定次序。
      const rows = await db.query<UserQualificationRow>(
        `SELECT ${COLUMNS} FROM user_qualifications
          ORDER BY user_id ASC, role ASC`,
      );
      return rows.map(toQualification);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgQualificationRepository: QualificationRepository =
  createQualificationRepository(lazyPgExecutor());
