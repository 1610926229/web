import type { PageResult } from "@/lib/types/common";
import type { Suggestion } from "@/lib/types/suggestion";
import { mockSuggestionRepository } from "./mockSuggestionRepository";
import { isPostgresDataSourceEnabled } from "./pg/config";
import { pgSuggestionRepository } from "./pg/suggestionRepository";

/**
 * 意见反馈的可替换仓储。
 *
 * 与投诉仓储同一套路：**写入侧**保证原子性与幂等，读取侧只按用户查。
 *
 * 一条约束由本层负责，不能靠调用方自觉：
 *
 * **同一次提交意图只产生一条反馈**（「用户 + 幂等键」）。反馈没有「一单一评」那样的
 * 业务唯一键——同一个用户完全可以提两条内容相同的建议——因此幂等键就是唯一的防重手段，
 * 「查是否已存在」与「写入新记录」在同一段同步代码里完成，快速连点、网络重试、
 * 并发提交都不会多出记录。按钮禁用只是提示，真正兜底的是这里。
 *
 * ⚠️ 本层**不判断**「这条反馈是谁的」「状态能不能改成已回复」：前者由服务层用
 * `userId` 作为查询条件保证，后者根本不存在用户端入口（回复只能来自预置或后台数据）。
 *
 * 有两个实现：进程内内存存储（默认）与 PostgreSQL（`DATA_SOURCE=postgres`）。
 * 数据库版的 `UNIQUE (userId, idempotencyKey)` 正是上面那条约束的落点，
 * 而**这份契约一个字没改**——服务层 `createSuggestionForUser` 不用改。
 */

export type SuggestionListQuery = {
  /** 查询条件的一部分，不是可选的过滤项：本方法只可能返回该用户的反馈 */
  userId: string;
  page: number;
  pageSize: number;
};

/** 创建结果：要么新建，要么命中幂等键返回上一次的结果。 */
export type CreateSuggestionOutcome = {
  suggestion: Suggestion;
  created: boolean;
};

export type SuggestionRepository = {
  /** 某个用户的反馈，按提交时间倒序 + 分页。 */
  querySuggestions(query: SuggestionListQuery): Promise<PageResult<Suggestion>>;

  /** 按「用户 + 幂等键」查已提交过的反馈；不存在返回 null。 */
  findSuggestionByKey(userId: string, idempotencyKey: string): Promise<Suggestion | null>;

  /**
   * 创建反馈。
   *
   * 幂等：同「用户 + 幂等键」已存在时返回既有记录并把 `created` 置为 false。
   */
  createSuggestion(
    suggestion: Suggestion,
    idempotencyKey: string,
  ): Promise<CreateSuggestionOutcome>;
};

/**
 * 取当前生效的反馈仓储。
 *
 * PROD-1A 起有**两个实现**，由 `DATA_SOURCE` 显式选择（见 `lib/data/pg/config.ts`）。
 * 默认走 Mock，理由与 `getFavoriteRepository` 完全相同：迁移策略要求
 * 「active datasource 的切换必须满足事务闭包完整」，没迁完的仓储绝不能悄悄切。
 */
export function getSuggestionRepository(): SuggestionRepository {
  return isPostgresDataSourceEnabled() ? pgSuggestionRepository : mockSuggestionRepository;
}
