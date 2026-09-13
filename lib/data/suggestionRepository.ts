import type { PageResult } from "@/lib/types/common";
import type { Suggestion } from "@/lib/types/suggestion";
import { mockSuggestionRepository } from "./mockSuggestionRepository";

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
 * 当前实现是进程内内存存储，将来由数据库的唯一索引与事务替换——
 * 替换时这份契约不变（服务层不用改）。
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

export function getSuggestionRepository(): SuggestionRepository {
  return mockSuggestionRepository;
}
