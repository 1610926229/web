/**
 * 打手工作台的类型（P0-4）。
 *
 * ⚠️ **打手不是第四套账号**。这里没有任何「打手会话」的概念：打手身份 =
 * **现有的用户会话**（`requireUser()` / 用户端 Cookie）+ **一条有效的护航资料**
 * （`Companion`）。同一套类型里因此同时带着 `userId` 与 `companionId`，
 * 两者缺一不可：
 *
 * - `userId`：这个人是谁。会话给出的身份，与「我的订单」「我的评价」是同一个用户；
 * - `companionId`：他作为打手的那份**资料**是哪一条。收益、订单池、评价将来都挂在它上面。
 *
 * 一个用户可以既是老板又是打手，因此这两个 id 同时存在**不是**两个账号在互转，
 * 而是一个人身上的两种角色。
 */

/**
 * 打手工作台的会话身份（**不是**会话本身）。
 *
 * ⚠️ 这是一份**显式挑字段的 DTO**：`Companion` 实体里的 `enabled` / `removedAt` /
 * `applicationId` / `intro` / `sortOrder` / 统计字段一律不在这里。工作台只需要回答
 * 「你是谁、你的资料长什么样」，多一个内部字段就多一条泄漏路径。
 */
export type CompanionSessionUser = {
  /** 用户身份，来自既有的用户会话 */
  userId: string;
  /** 作为打手的资料 id */
  companionId: string;
  /** 打手昵称（护航资料的 `displayName`，不是用户昵称） */
  displayName: string;
  avatarUrl: string;
};

/**
 * 一个**已登录用户**与打手能力的关系。
 *
 * ⚠️ 这里**没有 `anonymous`**：本类型的入参就是一个 `userId`，「有没有登录」
 * 是调用方（接口守卫 / 页面）在更外面用用户会话回答的问题。把「未登录」混进来，
 * 会让这个判定同时依赖两套东西——而它现在是一个**纯查询**，node 里可以直接测。
 *
 * 三态互斥，含义各不相同：
 *
 * | 状态 | 含义 | 页面 |
 * | --- | --- | --- |
 * | `not-a-companion` | 没有**有效**的护航资料（从未通过审核，或已被软移除） | 「你还不是护航」 |
 * | `disabled` | 有护航资料，但被管理员下架 | 「护航资格已下架」 |
 * | `granted` | 可以进工作台 | 工作台概览 |
 *
 * ⚠️ **软移除落在 `not-a-companion`，不是第四种状态**：`findCompanionByUser` 的口径
 * 本来就是「有效护航（已移除的不算）」。再写一次 `removedAt === null` 就会有两个
 * 真值来源，而分叉的那一天，「被移除的护航」会以「资格已下架」出现在页面上——
 * 看起来像是等管理员点一下就能恢复。
 *
 * ⚠️ **`granted` 同时带着工作台要展示的数据**（`rankLabel`），这不是把两件事混在一起，
 * 而是**故意只留一份结果**：判定与展示若各查一次仓储，两次 `await` 之间资格可能刚好变化，
 * 于是页面出现「布局按旧记录渲染了工作台壳、内容却取不到资料」的中间态。
 * 只有一份结果，就不存在两份结果不一致的可能。
 * 反过来，`disabled` 与 `not-a-companion` 只够渲染一句提示，**不带**任何展示字段。
 */
export type CompanionAccessState =
  | { kind: "not-a-companion" }
  | { kind: "disabled"; companion: CompanionSessionUser }
  | {
      kind: "granted";
      companion: CompanionSessionUser;
      /** 护航资料里的段位标签（如「钻石打手」），展示用；与 `companion` 同一次读取 */
      rankLabel: string;
    };
