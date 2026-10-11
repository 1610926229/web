import type { StaffAccount } from "@/lib/types/staff";
import type { StaffRepository } from "../staffRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `StaffRepository` 的 PostgreSQL 实现（PROD-1E · Wave A）。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/staffRepository.ts` 里的接口一个字没改。
 *
 * ## 只实现**读**方法，不实现同步写原语
 *
 * Mock 的 `mockStaffRepository.ts` 除仓储方法外还导出四个**同步写原语**
 * （`findStaffWithUsername` / `createStaffRecord` / `applyStaffPatch` / `applyStaffFlags`）。
 * 它们服务于 `lib/data/adminStaffTransaction.ts` 的原子区段（`enabled` / `removedAt`
 * 与资料字段必须分开写、且与审计写在同一段不可打断的代码里），属于**管理端写事务**，
 * 不在本任务的范围内，因此这里**刻意不实现**——新增一套异步的 Pg 写原语会让
 * 「同一段区段」的结构性保证消失。它们由管理端写事务那条链路单独负责。
 *
 * ## 大小写不敏感用 `lower(btrim(username))`
 *
 * 登录名唯一性由 `staff_accounts_username_key` 这个**表达式唯一索引**保证，
 * 表达式就是 `lower(btrim(username))`（`0010_identity_and_accounts.sql:94-95`）。
 * `findStaffByUsername` 必须用**逐字相同的表达式**，否则「这个登录名能不能用」
 * 在两个存储上会给出不同答案：`Kefu-Xiaoyu` 与 `kefu-xiaoyu` 是同一个人。
 *
 * ⚠️ **该索引不排除已移除的账号**：`findStaffWithUsername` 遍历整张 Map，
 * 没有 `removedAt IS NULL` 这一条。本方法因此也不加这个条件。
 *
 * ## 已移除的账号照样查得到
 *
 * `findStaffById` / `listStaff` 都**含停用与已移除**：软删除不是删除记录，
 * 历史审计与操作注释还要指得到它。仓储不替调用方筛选。
 *
 * ## 排序：`listStaff` 从 Mock 的**非确定序**收敛到确定序
 *
 * Mock 的 `listStaff` 返回 `Map` 的插入序（`mockStaffRepository.ts:134-136`）。
 * Pg 用 `ORDER BY id` 给出跨进程、跨查询稳定的行序——**已登记的确定性化**，
 * 不是某个比较器的对齐。
 *
 * ## 时间
 *
 * `created_at` / `updated_at` / `last_login_at` / `removed_at` 都是 `timestamptz`，
 * 经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串（或 null），类型与 Mock 一致。
 */

type StaffRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  role: StaffAccount["role"];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  removed_at: string | null;
};

/** 领域对象会读到的列。显式列清单，不用 `SELECT *`——将来新增列不会自动外泄。 */
const COLUMNS =
  "id, username, display_name, avatar_url, role, enabled, " +
  "created_at, updated_at, last_login_at, removed_at";

function toStaffAccount(row: StaffRow): StaffAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    removedAt: row.removed_at,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个客服账号仓储。
 *
 * 与其它仓储同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储——
 * 事务内的读（例如登录时校验账号）因此与写入共享同一条连接与同一个快照。
 */
export function createStaffRepository(db: PgQueryable): StaffRepository {
  return {
    async findStaffById(id): Promise<StaffAccount | null> {
      const rows = await db.query<StaffRow>(
        `SELECT ${COLUMNS} FROM staff_accounts WHERE id = $1`,
        [id],
      );
      return rows[0] ? toStaffAccount(rows[0]) : null;
    },

    async findStaffByUsername(username): Promise<StaffAccount | null> {
      // 与 Mock 的 `findStaffWithUsername`（`mockStaffRepository.ts:53-65`）一致：
      // 去空白后为空则直接返回 null。SQL 里 `lower(btrim('')) = lower(btrim(''))` 恒真，
      // 若库里存在一条空白登录名的账号就会把它查出来——那是 Mock 明确拒绝的情形。
      if (!username.trim()) return null;

      // 比较表达式与唯一索引 `staff_accounts_username_key` **逐字相同**（见文件头）。
      // 不加 `removed_at IS NULL`：索引本身也不排除已移除的账号。
      const rows = await db.query<StaffRow>(
        `SELECT ${COLUMNS} FROM staff_accounts
          WHERE lower(btrim(username)) = lower(btrim($1))`,
        [username],
      );
      return rows[0] ? toStaffAccount(rows[0]) : null;
    },

    async listStaff(): Promise<StaffAccount[]> {
      // `ORDER BY id`：对 Mock 的 Map 插入序做**确定性化**（见文件头）。
      const rows = await db.query<StaffRow>(
        `SELECT ${COLUMNS} FROM staff_accounts ORDER BY id`,
      );
      return rows.map(toStaffAccount);
    },

    async markLoggedIn(id, at): Promise<StaffAccount | null> {
      // 只写 `last_login_at` 一列，**不碰 `updated_at`**——Mock 也没有碰它。
      // `RETURNING` 无行 = 账号不存在（返回 null）。
      const rows = await db.query<StaffRow>(
        `UPDATE staff_accounts
            SET last_login_at = $2
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [id, at],
      );
      return rows[0] ? toStaffAccount(rows[0]) : null;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgStaffRepository: StaffRepository = createStaffRepository(lazyPgExecutor());
