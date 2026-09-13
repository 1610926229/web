import type {
  CompanionApplication,
  CompanionApplicationStatus,
} from "@/lib/types/companionApplication";
import { mockCompanionApplicationRepository } from "./mockCompanionApplicationRepository";

/**
 * 护航入驻申请的可替换仓储（读写）。
 *
 * ⚠️ 本层只负责存取，**不判断**「这算不算重复提交」「昵称是不是空的」「游戏存不存在」——
 * 那些是业务规则，在 `lib/services/companionApplications.ts` 里做。
 *
 * 但有一条规则**必须**在这里再挡一次：**一个用户最多一条申请**。理由是并发——
 * 服务里「先查有没有、再创建」中间隔着对游戏目录的 `await`，两个同时到达的请求
 * 完全可能都查到「没有申请」。仓储的创建过程（读、判断、写）是同步的、
 * 中间没有 `await`，因此这里才是那条规则真正生效的地方，服务层那次检查只是为了
 * 给出更清楚的提示。
 *
 * 与优惠券 / 投诉 / 反馈同一套路：**写入侧**保证原子性与幂等，读取侧只按用户查。
 */

/** 创建结果。`kind` 说明这一次到底发生了什么，服务层据此决定返回还是报错。 */
export type CompanionApplicationCreateOutcome =
  | { kind: "created"; application: CompanionApplication }
  | { kind: "idempotent"; application: CompanionApplication }
  /** 同一个人已经有申请了（且不是同一个幂等键）——由服务层转成明确的业务错误 */
  | { kind: "already-applied"; application: CompanionApplication };

/**
 * 管理端列表的查询条件。
 *
 * ⚠️ 筛选在**数据层**完成，页面与接口都不自己过滤：两侧各写一份，
 * 迟早出现「页面上筛出来 3 条、接口返回 5 条」这种对不上的结果。
 * 排序不是条件——后台列表的排序只有一种，见 `compareApplicationsForAdmin()`。
 */
export type AdminApplicationFilter = {
  /** null 表示不限状态 */
  status: CompanionApplicationStatus | null;
  /** 空串表示不搜索 */
  keyword: string;
  /** 空串表示全部游戏 */
  gameId: string;
};

export type CompanionApplicationRepository = {
  /** 按用户取申请；没有申请返回 null。这是「一个人最多一条」的读取侧入口。 */
  findApplicationByUser(userId: string): Promise<CompanionApplication | null>;

  /** 按 id 取申请（不做归属判断，归属由服务层校验）。 */
  findApplicationById(id: string): Promise<CompanionApplication | null>;

  /**
   * 按状态统计**全部**申请（不区分用户）。
   *
   * 这是本仓储唯一的跨用户读取入口，只服务管理后台的概览与列表——
   * 用户端的每一次查询都必须按用户过滤，`findApplicationByUser` 才是那条路径。
   * 返回计数而不是记录列表：概览只需要数字，没有必要把全部申请正文取出来。
   */
  countApplicationsByStatus(): Promise<Record<CompanionApplicationStatus, number>>;

  /**
   * 后台列表：**全部用户**的申请，按条件筛选并按提交时间倒序。
   *
   * 与 `countApplicationsByStatus()` 是同一个「跨用户读取」的例外通道，
   * 只服务管理后台。用户端的每一次查询都必须按用户过滤，
   * `findApplicationByUser` 才是那条路径。
   *
   * 不做分页：分页是服务层的事（与陪玩列表同一套 `clampPage` 规则），
   * 数据层只回答「符合条件的有哪些、什么顺序」。
   */
  queryApplicationsForAdmin(filter: AdminApplicationFilter): Promise<CompanionApplication[]>;

  /** 按「用户 + 幂等键」查已提交过的申请；不存在返回 null。 */
  findApplicationByKey(userId: string, idempotencyKey: string): Promise<CompanionApplication | null>;

  /**
   * 幂等创建。
   *
   * - 同「用户 + 幂等键」已存在 → `idempotent`，返回第一次的那条；
   * - 该用户已有别的申请 → `already-applied`，**不写第二条**；
   * - 其余情况 → `created`。
   */
  createApplication(
    application: CompanionApplication,
    idempotencyKey: string,
  ): Promise<CompanionApplicationCreateOutcome>;

  /**
   * 撤销：把状态改成 `withdrawn`。
   *
   * **只改状态，不删除记录**——用户仍然要能在进度页看到自己提交过什么。
   * 只有当前状态是 `pending` 时才改（这条判断同样放在无 `await` 的原子区段里）；
   * 已经是 `withdrawn` 时原样返回并把 `withdrawn` 置为 false（重复撤销是幂等的）。
   * 其余状态返回 null，由服务层转成业务错误。
   */
  withdrawApplication(
    id: string,
    at: string,
  ): Promise<{ application: CompanionApplication; withdrawn: boolean } | null>;
};

export function getCompanionApplicationRepository(): CompanionApplicationRepository {
  return mockCompanionApplicationRepository;
}
