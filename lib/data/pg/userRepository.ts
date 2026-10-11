import type { UserProfilePatch, UserRecord, UserRepository } from "../userRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `UserRepository` 的 PostgreSQL 实现（PROD-1E · Wave A）。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/userRepository.ts` 里的接口一个字没改，
 * 服务层、路由、页面都不知道底下换了一个存储。所有读取路径都通过这个工厂拿到
 * `UserRecord`，与 `mockUserRepository` 的返回形状逐字段一致。
 *
 * ## 时间列：这张表**没有**时间列
 *
 * `users` 就是没有 `created_at` / `updated_at`（`0010_identity_and_accounts.sql:19-24`：
 * 凭空多一个「注册时间」列等于在库里放一个没人写、也没人读的字段）。因此本文件
 * 不硬塞时间，也不据此排序。
 *
 * ## 排序：`listUsers` 从 Mock 的**非确定序**收敛到确定序
 *
 * Mock 的 `listUsers` 返回 `Map` 的插入序（`mockUserRepository.ts:51`）。`Map` 的插入序
 * 在单个进程内是稳定的，但**不是业务事实**——它是「预置数据恰好按什么顺序塞进 Map」的
 * 副产品，换一个存储（或换一次 seed 顺序）就会变。
 *
 * Pg 用 `ORDER BY id` 给出**确定性**行序：跨进程、跨查询、跨数据库重启都一样。
 * 这是对 Mock 非确定序的确定性化，是**已登记的取舍**，不是「Mock 排过序」。
 * 消费排行榜（本方法唯一的调用方）会在服务层自行聚合排序，不依赖本序。
 *
 * ## 更新是**窄写入**，不是整行覆盖
 *
 * `updateProfile` 只写三个资料字段。`id` / `display_id` 不出现在 `SET` 里——
 * 与 Mock 的「展开既有记录后只覆盖三个字段」结构等价：编辑资料不可能变成修改身份字段。
 * 一条 `UPDATE … RETURNING` 同时完成「存在性判断」与「写入」，不需要先 `SELECT` 一次
 * （那正是并发下会分叉的写法）。
 *
 * ## `toSessionUser` 不在本文件重复实现
 *
 * 它是 `lib/data/userRepository.ts` 里的纯函数，与存储无关；仓储实现只负责取数据。
 */

type UserRow = {
  id: string;
  display_id: string;
  nickname: string;
  avatar_url: string;
  bio: string;
};

/**
 * 领域对象会读到的列。
 *
 * ⚠️ 显式列清单，不用 `SELECT *`：将来 `users` 新增一列时它**不会**自动流进
 * `UserRecord`——多一个字段必须在这里再写一行，而那正是「该不该给用户端看」被
 * 重新判断一次的地方。
 */
const COLUMNS = "id, display_id, nickname, avatar_url, bio";

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    displayId: row.display_id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    bio: row.bio,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个用户仓储。
 *
 * 与收藏 / 投诉同构：**同一个工厂同时产出普通仓储与事务内仓储**。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让资料写入与同一事务里的
 * 其它写入共享同一条连接、同一个提交点。
 */
export function createUserRepository(db: PgQueryable): UserRepository {
  return {
    async findUserById(id): Promise<UserRecord | null> {
      const rows = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
      return rows[0] ? toUserRecord(rows[0]) : null;
    },

    async listUsers(): Promise<UserRecord[]> {
      // `ORDER BY id`：对 Mock 的 Map 插入序做**确定性化**（见文件头）。
      // 它不是「对齐某个比较器」——Mock 没有比较器，这里只是让同一份数据每次行序相同。
      const rows = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users ORDER BY id`);
      return rows.map(toUserRecord);
    },

    async updateProfile(id, patch: UserProfilePatch): Promise<UserRecord | null> {
      // 一条语句完成判定与写入：`RETURNING` 有行就是改到了，没行就是记录不存在（返回 null）。
      // `SET` 里只有三个资料字段，`id` / `display_id` 一个字都不动。
      const rows = await db.query<UserRow>(
        `UPDATE users
            SET nickname = $2,
                avatar_url = $3,
                bio = $4
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [id, patch.nickname, patch.avatarUrl, patch.bio],
      );
      return rows[0] ? toUserRecord(rows[0]) : null;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgUserRepository: UserRepository = createUserRepository(lazyPgExecutor());
