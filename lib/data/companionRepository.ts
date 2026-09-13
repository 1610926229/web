import type { CompanionListQuery } from "@/lib/constants/companions";
import type { Companion } from "@/lib/types/companion";
import { mockCompanionRepository } from "./mockCompanionRepository";

/**
 * 护航（陪玩）名单的可替换仓储（读写）。
 *
 * ⚠️ **全站只有这一份名单**。P4 结算页的「推荐陪玩」面板、公开的陪玩列表与详情、
 * 管理后台的护航管理读的都是这里，因此「后台改完资料，前台立刻是新值」不是靠刷新两次
 * 做到的，而是因为三处读的本来就是同一条记录。**禁止再建第二份护航名单**。
 *
 * 本层只负责存取与「一份数据」的一致性，**不判断**业务规则：
 * 「昵称能不能为空」「游戏与大区是否匹配」「停用时是否必须同时停接单」都在
 * `lib/services/adminCompanions.ts` 里做。仓储只保证自己这份数据自洽。
 *
 * 三条查询口径刻意分开，因为它们的可见范围完全不同：
 * - `listCompanions()`：**完整**名单，含下架、含暂不可接单、含已移除。
 *   结算页用它（它要的是「全部候选 + 每个人的可用状态」）；
 * - `queryCompanions()`：**公开列表**口径，下架与已移除都不出现；
 * - `queryCompanionsForAdmin()`：后台口径，全部记录都能查，且能按启用 / 可接单 /
 *   是否已移除筛选——后台要能看见前台看不见的那些。
 */

/**
 * 创建护航资料的结果。
 *
 * `already-linked` 是关键：**一名用户最多关联一条有效护航**这条规则真正生效的地方
 * 就是这个仓储（`companionIdByUser` 索引），而不是服务层那次检查——
 * 服务层「先查有没有、再创建」中间隔着 `await`，两个同时到达的请求完全可能都查到「没有」。
 */
export type CompanionCreateOutcome =
  | { kind: "created"; companion: Companion }
  | { kind: "already-linked"; companion: Companion };

/**
 * 后台筛选条件（已解析、已校验；**不含分页**）。
 *
 * 分页不在这里，与公开列表同一套分工：仓储负责「哪些记录入选」，
 * 分页由服务层按 `page` / `pageSize` 切片。两边各切一半的话，
 * 「总数」与「本页条数」迟早会来自两次不同的过滤。
 *
 * `removal` 只有两个取值，没有「全部」：后台的默认视图是「未移除的护航」，
 * 要看已移除的必须显式选——否则一条被移除的记录会混在正常名单里，
 * 看起来就像移除根本没生效。
 */
export type AdminCompanionFilter = {
  keyword: string;
  gameId: string;
  /** `""` 表示不限上架状态 */
  enabled: "" | "enabled" | "disabled";
  /** `""` 表示不限接单状态 */
  availability: "" | "available" | "unavailable";
  removal: "active" | "removed";
};

export type CompanionRepository = {
  /** 完整名单（含下架、含已移除）。结算页读它。 */
  listCompanions(): Promise<Companion[]>;

  /** 按 id 取；不存在返回 null。**已移除的记录仍然取得到**（后台详情要看它）。 */
  findCompanionById(id: string): Promise<Companion | null>;

  /**
   * 按用户取**有效**护航资料（已移除的不算）。
   *
   * 这是「一名用户最多关联一条有效护航」的读取侧入口，审核通过前用它做检查，
   * 后台的申请详情也用它回答「这位申请人已经是护航了吗」。
   */
  findCompanionByUser(userId: string): Promise<Companion | null>;

  /**
   * 公开列表查询：下架与已移除的记录不出现。
   *
   * 参数**不含分页**（`Omit<…, "page" | "pageSize">`）：`CompanionListQuery` 是
   * 「页面 / 接口传来的完整条件」，把它整个塞进仓储会让「谁负责切片」变得含糊。
   * 传一个带 `page` 的变量进来是允许的（结构类型只要求这里用到的字段），
   * 但仓储不读它——分页在 `lib/data/mockSource.ts` 与 `lib/services/*` 里做。
   */
  queryCompanions(query: Omit<CompanionListQuery, "page" | "pageSize">): Promise<Companion[]>;

  /** 后台列表查询：全部记录，按启用 / 可接单 / 是否已移除筛选。 */
  queryCompanionsForAdmin(query: AdminCompanionFilter): Promise<Companion[]>;

  /** 全部记录（后台聚合用，与 `listCompanions()` 同源，只是语义更明确）。 */
  listCompanionsForAdmin(): Promise<Companion[]>;

  /**
   * 为某个用户创建护航资料。
   *
   * 该用户已经有**有效**护航时返回 `already-linked` 并**不写第二条**——
   * 重复审核通过、并发审核通过都会走到这里，规则只在这一处生效。
   */
  createCompanion(companion: Companion): Promise<CompanionCreateOutcome>;

  /**
   * 覆盖式更新资料。
   *
   * ⚠️ `patch` **只包含后台可以改的字段**（昵称 / 头像 / 介绍 / 游戏 / 大区 / 标签 /
   * 启用 / 可接单 / 不可接单原因 / 排序）——统计字段（评分、完成单数、评价数、鸡腿数）
   * 与关联用户、来源申请**不在 patch 类型里**，因此没有「顺手改一下统计」的入口。
   * 记录不存在返回 null。
   */
  updateCompanion(
    id: string,
    patch: CompanionProfilePatch,
  ): Promise<{ previous: Companion; updated: Companion } | null>;

  /**
   * 软移除：写 `removedAt`，**不删除记录**。
   *
   * 历史订单、评价与鸡腿记录都要继续指得到这条资料，因此移除只改这一个字段。
   * 已经移除的记录返回 `previous === updated`（幂等，不刷新时间戳）。
   */
  markCompanionRemoved(
    id: string,
    at: string,
  ): Promise<{ previous: Companion; updated: Companion } | null>;
};

/** 后台可编辑的字段。**统计字段与身份字段不在这里**，这是「不可篡改」的类型级保证。 */
export type CompanionProfilePatch = {
  displayName: string;
  avatarUrl: string;
  intro: string;
  gameIds: string[];
  regions: string[];
  serviceTags: string[];
  enabled: boolean;
  available: boolean;
  unavailableReason: string;
  sortOrder: number;
};

export function getCompanionRepository(): CompanionRepository {
  return mockCompanionRepository;
}
