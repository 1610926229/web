/**
 * 消费排行榜的类型与对外 DTO。
 *
 * ⚠️ **隐私边界**：排行榜是**公开**内容（游客可访问），因此对外 DTO 只有五项——
 * 名次、昵称、头像、当前等级名称、累计有效消费金额。`userId`、`displayId`、
 * 简介、游戏 ID、订单详情一律不出现在响应里；页面需要的稳定 key 用**名次**即可
 * （同一份榜单内名次唯一），无需把内部用户标识发给浏览器。
 *
 * 服务端的聚合中间形态是 `ConsumptionRankingRow`，它带 `userId`——
 * 那是**排序兜底与「我的排名」匹配**需要的，只存在于服务端，不会进入 DTO。
 *
 * 金额一律是「分」为单位的整数。
 */

import type { PageResult } from "./common";
import type { RankingPeriod } from "@/lib/constants/rankingPeriods";

/**
 * 服务端聚合产出的一行（**内部形态，不对外**）。
 *
 * `userId` 存在两个用途：金额相同时的确定性第二排序条件（升序），
 * 以及从榜单里找出当前登录用户的那一行。二者都在服务端完成。
 */
export type ConsumptionRankingRow = {
  userId: string;
  nickname: string;
  avatarUrl: string;
  /** 该用户的消费等级名称；等级配置不可用时为空串 */
  levelName: string;
  /** 所选周期内的有效消费金额，单位：分。只有 > 0 的用户会进入榜单 */
  effectiveSpendAmount: number;
};

/**
 * 榜单条目（对外公开 DTO）。
 *
 * 字段就是这五项，**没有 id**：客户端列表用 `rank` 作 React key。
 * 名次在同一页与跨页之间都唯一，因此不需要再额外下发一个公开标识。
 */
export type RankingEntry = {
  /** 名次，从 1 开始 */
  rank: number;
  nickname: string;
  avatarUrl: string;
  /** 当前消费等级名称；等级配置不可用时为空串，页面显示「等级待配置」 */
  levelName: string;
  /** 单位：分 */
  effectiveSpendAmount: number;
};

/** 排行榜分页响应。 */
export type ConsumptionRankingPage = PageResult<RankingEntry> & {
  /** 榜单生成时间（服务端），页面上显示「更新于 …」 */
  generatedAt: string;
  /**
   * 当前登录用户在**当前周期**下的排名摘要。
   *
   * - 游客：null（页面不显示「我的排名」区域，也不要求登录）；
   * - 已登录但**该周期内没有有效消费**：null（不进入榜单，页面写明原因）；
   * - 已登录且该周期内有有效消费：该用户的名次（即使不在当前这一页里也照样给出）。
   */
  me: RankingEntry | null;
  /** 本次请求是否带有有效登录态。用来区分「游客」与「登录了但没上榜」 */
  viewerLoggedIn: boolean;
  /** 统计口径说明（周期榜与累计榜的说明不同） */
  notice: string;
  /** 本次响应对应的周期。页面据此判定迟到的响应是否还该被采纳 */
  period: RankingPeriod;
  /** 周期的中文名 */
  periodLabel: string;
  /**
   * 周期起始时刻（含），ISO 字符串；累计期为 null。
   *
   * 与 `rangeEnd` 一样只用于展示与排查，**不含任何隐私内容**：
   * 它描述的是「这份榜单算了哪一段时间」，与具体订单无关。
   */
  rangeStart: string | null;
  /** 周期结束时刻（**不含**），ISO 字符串 */
  rangeEnd: string;
};
