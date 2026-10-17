import type { PageResult } from "@/lib/types/common";
import type { Favorite } from "@/lib/types/favorite";
import type { AddFavoriteOutcome, FavoriteRepository } from "../favoriteRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `FavoriteRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/favoriteRepository.ts` 里的接口一个字没改，
 * 上层服务层、路由、页面都不知道底下换了一个存储。这是 PROD-1A 要证明的第 15 条。
 *
 * ## 这一版真正要消灭的东西：SELECT-then-INSERT
 *
 * `mockFavoriteRepository.addFavorite` 是这么写的：
 *
 *     const existing = current.favorites.get(key);
 *     if (existing) return { ok: true, favorite: existing, created: false };
 *     current.favorites.set(key, favorite);
 *
 * 在「单线程 + 区段内没有 await」的前提下这是原子的。换成数据库后同样的写法
 * （先 `SELECT` 判断、没有再 `INSERT`）会在两个并发请求之间出现空档：
 * 两边都查到「没有」，然后都去写 —— 一条收藏变成两条，而且没有任何报错。
 *
 * 这里改成**单条 `INSERT … ON CONFLICT DO NOTHING RETURNING`**：
 * 判重的职责从「先读一次再决定」搬到了**唯一索引**上，读不再是决策依据。
 * 冲突时读回既有记录，读到的已经是索引替我们选定并保住的那一行。
 *
 * 这不是「换了个写法」，而是**把并发正确性从应用层挪到了数据库层**——
 * 应用层的判断在有任何 `await` 的代码里都不成立，数据库的约束在任何并发下都成立。
 *
 * ## 时间类型
 *
 * `created_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串，
 * 因此 `Favorite.createdAt` 仍然是 `string`，Mock 里那套字典序比较原样成立。
 */

type FavoriteRow = {
  id: string;
  user_id: string;
  product_id: string;
  created_at: string;
};

const COLUMNS = "id, user_id, product_id, created_at";

function toFavorite(row: FavoriteRow): Favorite {
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    createdAt: row.created_at,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个收藏仓储。
 *
 * **同一个工厂同时产出两种仓储**，这是本层最重要的设计点：
 *
 * - 传进程级执行器 → 普通仓储，每条语句自动提交；
 * - 传 `withTransaction` 给出的 `TxHandle` → **事务内仓储**，与同一事务里的其它写入
 *   共享同一条连接、同一个提交点。
 *
 * 两边的接口完全一样，所以「收藏 + 别的什么」要一起成功或一起失败时，
 * 调用方**不需要换一套 API**，只要把 `tx` 传进来。
 */
export function createFavoriteRepository(db: PgQueryable): FavoriteRepository {
  async function findFavorite(userId: string, productId: string): Promise<Favorite | null> {
    const rows = await db.query<FavoriteRow>(
      `SELECT ${COLUMNS} FROM favorites WHERE user_id = $1 AND product_id = $2`,
      [userId, productId],
    );
    return rows[0] ? toFavorite(rows[0]) : null;
  }

  async function countFavorites(userId: string): Promise<number> {
    const rows = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM favorites WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.total ?? 0;
  }

  return {
    findFavorite,

    async queryFavorites({ userId, page, pageSize }): Promise<PageResult<Favorite>> {
      const start = (page - 1) * pageSize;

      // total 与当前页在**同一条语句**里取（窗口函数），因此它们看到的是同一个快照——
      // 分两条语句查 count 与列表，中间被并发插入插一脚，hasMore 就会算错。
      const rows = await db.query<FavoriteRow & { total: number }>(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM favorites
          WHERE user_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [userId, pageSize, start],
      );

      // 翻到超出末页时窗口函数没有行可依附，拿不到 total：
      // 这种情况只发生在越界页，补一次计数即可（`page === 1` 时空结果就是 total = 0）
      const total = rows.length > 0 ? rows[0].total : page > 1 ? await countFavorites(userId) : 0;
      const items = rows.map(toFavorite);

      return {
        items,
        page,
        pageSize,
        total,
        // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
        hasMore: start + items.length < total,
      };
    },

    async addFavorite(favorite): Promise<AddFavoriteOutcome> {
      // 最多两轮。第二轮只在「冲突命中后、读回之前，那行被并发删掉了」时才会发生。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await db.query<FavoriteRow>(
          `INSERT INTO favorites (id, user_id, product_id, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, product_id) DO NOTHING
           RETURNING ${COLUMNS}`,
          [favorite.id, favorite.userId, favorite.productId, favorite.createdAt],
        );
        if (inserted[0]) return { ok: true, favorite: toFavorite(inserted[0]), created: true };

        const existing = await db.query<FavoriteRow>(
          `SELECT ${COLUMNS} FROM favorites WHERE user_id = $1 AND product_id = $2`,
          [favorite.userId, favorite.productId],
        );
        if (existing[0]) return { ok: true, favorite: toFavorite(existing[0]), created: false };

        // 走到这里说明既有记录在两步之间被删了：条件已不成立，重来一次 INSERT
      }

      throw new Error(
        `收藏写入在并发下未能收敛（用户 ${favorite.userId} / 商品 ${favorite.productId}）。`,
      );
    },

    async removeFavorite(userId, productId) {
      // 一条语句完成判定与写入：`RETURNING` 有行就是删掉了，没行就是本来就不在。
      // 「先查在不在、再删」在这里同样没有必要，也没有意义。
      const removed = await db.query<{ id: string }>(
        `DELETE FROM favorites WHERE user_id = $1 AND product_id = $2 RETURNING id`,
        [userId, productId],
      );
      return { removed: removed.length > 0 };
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgFavoriteRepository: FavoriteRepository = createFavoriteRepository(lazyPgExecutor());
