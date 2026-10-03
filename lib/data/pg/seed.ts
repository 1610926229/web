import { favoriteSeed } from "@/lib/mocks/fixtures/favoriteSeed";
import { suggestionSeed } from "@/lib/mocks/fixtures/suggestionSeed";
import { assertSeedAllowed } from "./config";
import type { PgExecutor, PgQueryable } from "./executor";

/**
 * 开发 / 测试环境的预置数据写入（**仅服务端**）。
 *
 * ## 为什么直接复用 `lib/mocks/fixtures/*`
 *
 * 因为竖切片要证明的事情之一是「**Mock 与 PostgreSQL 在同一份数据上给出一致结果**」。
 * 若给数据库另写一套种子，两个实现比的就不是同一份输入，
 * 「结果一致」也就说明不了任何问题。复用同一份 `favoriteSeed` / `suggestionSeed`，
 * 连 id、时间戳、边界用例（已下架商品、已删除商品、另一个用户的收藏、
 * 三个状态的反馈）都完全对齐。
 *
 * ## 幂等
 *
 * 一律 `ON CONFLICT DO NOTHING`：重复执行不会报错，也不会产生第二份数据。
 * 这是 seed 与 migration 的语义差别——migration「跑过就不跑」，seed「跑几次都一样」。
 *
 * ⚠️ 预置数据里的 `createdAt` 全部是**写死的**常量（不是 `now()`），
 * 所以「reset 之后数据是确定的」这句话才成立：每一轮的排序、分页、
 * 边界位置都落在同一处。
 */

export type SeedCounts = { inserted: number; skipped: number };

export type SeedResult = {
  favorites: SeedCounts;
  suggestions: SeedCounts;
};

/**
 * 先校验预置数据自身没有重复，再往库里写。
 *
 * ⚠️ 这两条检查是**必须**的，因为下面的插入统一用 `ON CONFLICT DO NOTHING`（不带冲突目标）。
 * 不带目标的写法会把**任何**唯一键冲突都当成「这行已经在了」而跳过——
 * 于是「种子里两条收藏撞了同一个 (用户, 商品)」这种数据错误会**静默少写一条**，
 * 而所有检查都显示正常。把重复挡在插入之前，`DO NOTHING` 就只可能在
 * 「重跑同一份种子」这种正当场景下生效。
 *
 * 这两条不变量与 `mockFavoriteRepository.createStore()` / `mockSuggestionRepository.createStore()`
 * 在建仓时做的检查是同一组——两个实现在同一份种子上必须表现出同样的行为。
 */
function assertSeedFixtures(): void {
  const favoriteIds = new Set<string>();
  const favoriteKeys = new Set<string>();
  for (const favorite of favoriteSeed) {
    if (favoriteIds.has(favorite.id)) {
      throw new Error(`预置收藏数据出现重复 id：${favorite.id}`);
    }
    favoriteIds.add(favorite.id);

    const key = `${favorite.userId}:${favorite.productId}`;
    if (favoriteKeys.has(key)) {
      throw new Error(`预置收藏数据重复：${key}`);
    }
    favoriteKeys.add(key);
  }

  const suggestionIds = new Set<string>();
  for (const suggestion of suggestionSeed) {
    if (suggestionIds.has(suggestion.id)) {
      throw new Error(`预置反馈数据出现重复 id：${suggestion.id}`);
    }
    suggestionIds.add(suggestion.id);
  }
}

/**
 * 预置收藏。
 *
 * ⚠️ `ON CONFLICT DO NOTHING` **刻意不带冲突目标**。看上去 `(user_id, product_id)`
 * 更精确，但它接不住一种很常见的开发场景：从界面上取消收藏（列表少了一条），
 * 再跑一次 seed —— 这时业务键不再冲突，插入会撞上主键 `favorites_pkey` 而报错。
 * 种子要的是「确保这些行存在」，任何唯一键冲突都只说明「它已经在某种形式下存在了」。
 * 数据本身的重复由 `assertSeedFixtures` 提前挡住，所以这里不会掩盖真实错误。
 */
async function seedFavorites(executor: PgQueryable): Promise<SeedCounts> {
  let inserted = 0;

  for (const favorite of favoriteSeed) {
    const rows = await executor.query<{ id: string }>(
      `INSERT INTO favorites (id, user_id, product_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [favorite.id, favorite.userId, favorite.productId, favorite.createdAt],
    );
    if (rows.length > 0) inserted += 1;
  }

  return { inserted, skipped: favoriteSeed.length - inserted };
}

/**
 * 预置反馈。
 *
 * ⚠️ `idempotency_key` 写 NULL，**照抄 Mock 的语义**：`mockSuggestionRepository.createStore()`
 * 只把种子放进 `suggestions`，并不往 `suggestionIdByKey` 里放东西，
 * 所以预置反馈在 Mock 里是「按幂等键查不到」的。NULL 在 UNIQUE 里互不冲突，
 * 两个实现对同一份种子的行为因此完全一致。理由详见 `db/migrations/0002_suggestions.sql`。
 *
 * ⚠️ 正因为键是 NULL，`ON CONFLICT (user_id, idempotency_key)` 这个写法在这里**是错的**：
 * 它接不住重复插入（NULL 互不冲突），重跑 seed 会直接撞上 `suggestions_pkey`。
 * 所以这里与收藏一样用不带目标的 `DO NOTHING`。
 */
async function seedSuggestions(executor: PgQueryable): Promise<SeedCounts> {
  let inserted = 0;

  for (const suggestion of suggestionSeed) {
    const rows = await executor.query<{ id: string }>(
      `INSERT INTO suggestions (
         id, user_id, type_key, type_label, content, contact,
         evidence, status, reply, replied_at, created_at, idempotency_key
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NULL)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        suggestion.id,
        suggestion.userId,
        suggestion.typeKey,
        suggestion.typeLabel,
        suggestion.content,
        suggestion.contact,
        JSON.stringify(suggestion.evidence),
        suggestion.status,
        suggestion.reply,
        suggestion.repliedAt,
        suggestion.createdAt,
      ],
    );
    if (rows.length > 0) inserted += 1;
  }

  return { inserted, skipped: suggestionSeed.length - inserted };
}

/**
 * 写入预置数据。
 *
 * 整体一个事务：要么两张表都拿到完整的种子，要么一张都没写。
 * 半份种子会让「Mock 与 Pg 结果一致」的比对得出一个假结论。
 *
 * ⚠️ 生产环境直接抛错（`assertSeedAllowed`）。
 */
export async function seedDatabase(executor: PgExecutor): Promise<SeedResult> {
  assertSeedAllowed();
  assertSeedFixtures();

  return executor.withTransaction(async (tx) => ({
    favorites: await seedFavorites(tx),
    suggestions: await seedSuggestions(tx),
  }));
}
