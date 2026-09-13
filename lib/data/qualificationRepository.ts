import { mockQualificationRepository } from "./mockQualificationRepository";

/**
 * 用户**资格**仓储（多角色结构里「平台侧身份」的落点）。
 *
 * ⚠️ 为什么不直接把角色写进 `UserRecord`：
 *
 * 1. **不能把普通用户身份覆盖掉**。一位老板通过审核后**仍然是老板**——还能下单、
 *    还能看自己的订单与收藏。把 `UserRecord` 改成「现在是陪玩」等于用新身份顶掉旧身份，
 *    稍不注意就会出现「成为护航之后下不了单」这类问题。资格是一条**附加记录**，
 *    用户记录一个字都不动，这个保证在类型层面就成立（`UserRecord` 里没有角色字段，
 *    这里也不 import 它）。
 * 2. **两种数据的生命周期不同**。用户资料是用户可以自己改的（昵称 / 头像 / 简介），
 *    资格是平台发的、带发放人与发放时间、还要能被审计。混在一张表里，
 *    「编辑资料」那次覆盖式更新迟早会把资格顺手抹掉。
 * 3. **一对多的方向不同**。一个用户可以同时是老板与护航；资格表天然是一对多，
 *    用户表加一列只能表达「当前是什么」。
 *
 * 本阶段只有一个资格取值 `"companion"`。刻意**不做**通用 RBAC：
 * 没有权限点、没有角色继承。取值写成联合类型而不是 `string`，
 * 是为了将来加第二个资格时，每一处 `switch` 都会被编译器找出来。
 *
 * ⚠️ 本层只负责存取：**不判断**「这个人配不配拿到护航资格」——那是审核服务的规则。
 */

/** 平台侧资格。`consumer`（老板）不在这个表里：它是每个用户的**默认身份**，不需要发放。 */
export type UserQualificationRole = "companion";

/** 一条资格记录。 */
export type UserQualificationRecord = {
  userId: string;
  role: UserQualificationRole;
  /** 资格对应的护航资料 id。**一名用户最多一条有效护航**，因此这里是一对一。 */
  companionId: string;
  /** 产生这条资格的入驻申请 id，用于追溯。 */
  applicationId: string;
  /** 发放时间，服务端写 */
  grantedAt: string;
  /** 发放的管理者 id。审计要能回答「谁批的」 */
  grantedByAdminId: string;
};

export type QualificationRepository = {
  /** 按用户 + 资格取；没有返回 null。 */
  findQualification(
    userId: string,
    role: UserQualificationRole,
  ): Promise<UserQualificationRecord | null>;

  /**
   * 某位用户的**全部**资格。
   *
   * 用列表而不是单个字段，是为了让「多角色」这件事在读取侧就是成立的：
   * 将来加了第二种资格，调用方不需要改签名。
   */
  listQualificationsByUser(userId: string): Promise<UserQualificationRecord[]>;

  /** 全部资格记录（后台聚合与测试用）。 */
  listQualifications(): Promise<UserQualificationRecord[]>;
};

export function getQualificationRepository(): QualificationRepository {
  return mockQualificationRepository;
}
