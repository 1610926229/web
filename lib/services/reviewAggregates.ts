import { EMPTY_REVIEW_AGGREGATE, buildReviewAggregate } from "@/lib/constants/reviews";
import { getReviewRepository } from "@/lib/data/reviewRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import type { ReviewAggregate, ReviewDimensionKey } from "@/lib/types/review";

/**
 * 公开评分聚合的取数 —— **商品侧与打手侧唯一的聚合入口**（`R3` / `D6`）。
 *
 * ## 为什么单独一个模块
 *
 * 商品详情与打手详情是两条互不相干的调用链，如果各自写一遍
 * 「查评价 → 滤 approved → 算平均 → 脱敏」，两边迟早会漂移：一边漏了状态过滤、
 * 或者一边把 `reviewCount` 数成了评价条数，而两套实现**都能看起来正常**——
 * 差别只在有没有人点进那一条被隐藏的评价。
 *
 * 因此这里把「取数」也收敛成一份：两个页面服务都调本模块，
 * 它内部固定走 `buildReviewAggregate()`（纯函数，`approved only` 与维度切分在那里，
 * 见 `lib/constants/reviews.ts`）。
 *
 * ## 昵称在这里解析，并且只解析一次
 *
 * 聚合结果里的昵称必须是**脱敏后**的（`D13`），而脱敏需要原始昵称，原始昵称属于用户资料。
 * 解析放在本模块，而不是让调用方各自去查用户表：调用方多一个参数就多一次遗忘的机会，
 * 而遗忘的表现是「某一条评价的昵称字段是空的」——不报错，只是少了个名字。
 *
 * ⚠️ 聚合结果里的 `reviews[].nickname` 已经是脱敏值（`maskNickname` 在
 * `toPublicReviewItem` 里就地执行）。本模块**不会**把原始昵称或 `userId` 传出去：
 * 返回类型是 `ReviewAggregate`，它的形状里根本没有这两个字段的位置。
 *
 * ## 将来接数据库时
 *
 * 这里的两次查询会变成一条按目标对象分组的聚合 SQL。契约不变：
 * 「某个对象在某个维度上的 approved 评价」这句话的含义由 `buildReviewAggregate()` 定义，
 * 本模块只负责把数据凑齐。
 */

/**
 * 一次批量聚合的结果：**与入参对象一一配对**，而不是一个 `Map`。
 *
 * ⚠️ 用配对而不是 `Map` 是刻意的：`Map` 的调用方要写 `stats.get(id) ?? 空聚合`，
 * 而那行 `??` 会变成一个「查不到就显示暂无评分」的静默兜底——某个 id 因为拼错、
 * 或者某次重构改了 id 的来源，页面上不会报错，只会少掉一个评分。
 * 配对之后，**每个对象必然带着它自己的聚合结果**，没有分支可以走偏。
 */
export type ReviewStatsRow<T> = { item: T; stats: ReviewAggregate };

/** 昵称解析器：把「用户 id → 原始昵称」这件事收成一处。 */
type NicknameResolver = (userId: string) => string;

/**
 * 取名解析器。**每次现查用户表，不缓存到模块级**：
 * 测试里 `resetMockStore()` 会换掉整份存储，缓存下来的映射会指向一批已经不存在的用户，
 * 表现是「评价都在，昵称全变成了匿名用户」。
 */
async function nicknameResolver(): Promise<NicknameResolver> {
  const users = await getUserRepository().listUsers();
  const nicknameById = new Map(users.map((user) => [user.id, user.nickname]));
  // 查不到作者时返回空串，由 `maskNickname` 统一收敛成「匿名用户」——
  // 这里**不要**造一个假昵称：编出来的名字会让读者以为真有其人
  return (userId) => nicknameById.get(userId) ?? "";
}

/** 单个对象走一遍完整的「取数 → 聚合」。**唯一**一处调用 `buildReviewAggregate` 的地方。 */
async function aggregateOne(
  key: ReviewDimensionKey,
  targetId: string,
  nickname: NicknameResolver,
): Promise<ReviewAggregate> {
  const repository = getReviewRepository();
  const reviews =
    key === "product"
      ? await repository.listReviewsByProduct(targetId)
      : await repository.listReviewsByCompanion(targetId);

  // 完全没有评价时不进入聚合：这是最常见的一条路径（新商品、新打手）。
  // 短路掉它，也就不必为了一个必然为空的结果去解析昵称。
  // 复制一份而不是直接返回那个常量：`reviews` 是数组，共享出去之后
  // 任何一个调用方顺手 push 一下，全局的「空聚合」就不再是空的了
  if (reviews.length === 0) return { ...EMPTY_REVIEW_AGGREGATE, reviews: [] };

  return buildReviewAggregate({ reviews, key, targetId, nickname });
}

/**
 * 单个对象的聚合。
 *
 * 用于详情页（一次只有一个对象）。列表页请用 `loadReviewStatsFor()`，它只查一次用户表。
 */
export async function loadReviewAggregate(
  key: ReviewDimensionKey,
  targetId: string,
): Promise<ReviewAggregate> {
  return aggregateOne(key, targetId, await nicknameResolver());
}

/**
 * 批量聚合 —— **列表页用这个**（陪玩列表上每张卡片都有评分）。
 *
 * 逐条调用 `loadReviewAggregate` 会为每个对象各查一次用户表；一页最多 20 条，
 * 那样是 20 次全表读。这里把用户表查一次、复用给全部对象。
 */
export async function loadReviewStatsFor<T>(
  key: ReviewDimensionKey,
  rows: readonly { item: T; id: string }[],
): Promise<ReviewStatsRow<T>[]> {
  if (rows.length === 0) return [];

  const nickname = await nicknameResolver();

  const result: ReviewStatsRow<T>[] = [];
  for (const row of rows) {
    result.push({ item: row.item, stats: await aggregateOne(key, row.id, nickname) });
  }

  return result;
}
