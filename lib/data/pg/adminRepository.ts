import type { AdminAccount } from "@/lib/types/admin";
import type { AdminRepository } from "../adminRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `AdminRepository` 的 PostgreSQL 实现（PROD-1E · Wave A）。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/adminRepository.ts` 里的接口一个字没改。
 *
 * ## 与用户仓储是两个仓储
 *
 * 这一点是刻意的，换存储后依然成立：用户端那条链路读的是 `users`，管理端读的是
 * `admin_accounts`。两个 id 空间、两份数据。**合成一张表再加一个 `role` 字段**，
 * 等于让用户端那条链路拿到了角色信息——而「用户端读不到角色」正是管理权限无法
 * 从用户侧伪造的原因之一（`lib/types/admin.ts` 的说明）。
 *
 * ## 时间列
 *
 * `admin_accounts` **只有** `last_login_at`（`0010_identity_and_accounts.sql:44-56`）：
 * 没有 `created_at` / `updated_at` / `removed_at`，因为 Mock 的 `AdminAccount`
 * 里就没有这些字段。因此本文件不写、不读这些列。
 *
 * ## 排序：`listAdmins` 从 Mock 的**非确定序**收敛到确定序
 *
 * Mock 的 `listAdmins` 返回 `Map` 的插入序（`mockAdminRepository.ts:38-40`）。
 * 那是「seed 恰好按什么顺序塞进 Map」的副产品，不是业务事实。Pg 用 `ORDER BY id`
 * 给出跨进程、跨查询都稳定的行序。这是对 Mock 非确定序的确定性化，
 * 是**已登记的取舍**，不是某个比较器的对齐。
 *
 * ## `markLoggedIn` 是审计信息，不是权限依据
 *
 * 与 Mock 一样只写 `last_login_at` 一列，`RETURNING` 无行表示账号不存在（返回 null）。
 * 调用方不依赖它是否成功（见接口说明）。
 */

type AdminRow = {
  id: string;
  username: string;
  display_name: string;
  role: AdminAccount["role"];
  enabled: boolean;
  last_login_at: string | null;
};

/**
 * 领域对象会读到的列。显式列清单，不用 `SELECT *`——将来新增列不会自动外泄。
 *
 * ⚠️ **不含任何密码 / 凭据列**，因为它们本来就不存在于这张表：
 * 本阶段是 Mock 认证，库里没有「密码哈希」「盐」这类字段。
 */
const COLUMNS = "id, username, display_name, role, enabled, last_login_at";

function toAdminAccount(row: AdminRow): AdminAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    enabled: row.enabled,
    // `timestamptz` 经 `pool.ts` 的解析器钩子还原成 ISO 字符串（或 null），类型与 Mock 一致
    lastLoginAt: row.last_login_at,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个管理端账号仓储。
 *
 * 与其它仓储同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储。
 */
export function createAdminRepository(db: PgQueryable): AdminRepository {
  return {
    async findAdminById(id): Promise<AdminAccount | null> {
      const rows = await db.query<AdminRow>(
        `SELECT ${COLUMNS} FROM admin_accounts WHERE id = $1`,
        [id],
      );
      return rows[0] ? toAdminAccount(rows[0]) : null;
    },

    async listAdmins(): Promise<AdminAccount[]> {
      // `ORDER BY id`：对 Mock 的 Map 插入序做**确定性化**（见文件头）。
      const rows = await db.query<AdminRow>(
        `SELECT ${COLUMNS} FROM admin_accounts ORDER BY id`,
      );
      return rows.map(toAdminAccount);
    },

    async markLoggedIn(id, at): Promise<AdminAccount | null> {
      // 只写 `last_login_at` 一列；`RETURNING` 无行 = 账号不存在（返回 null）。
      const rows = await db.query<AdminRow>(
        `UPDATE admin_accounts
            SET last_login_at = $2
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [id, at],
      );
      return rows[0] ? toAdminAccount(rows[0]) : null;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgAdminRepository: AdminRepository = createAdminRepository(lazyPgExecutor());
