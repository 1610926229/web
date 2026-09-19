import { getCompanionRepository } from "@/lib/data/companionRepository";
import type { CompanionAccessState, CompanionSessionUser } from "@/lib/types/companionWorkspace";
import type { Companion } from "@/lib/types/companion";

/**
 * 打手访问服务 —— 打手**唯一**的资格判定入口（P0-4）。
 *
 * 一个用户能不能进打手工作台，只有这一个问题要回答：
 * **他名下有没有一条有效的、且已上架的护航资料。**
 *
 * 三条边界，本文件是它们的落点：
 *
 * 1. **身份来自用户会话，不来自第二套会话**。这里的入参是一个 `userId`——
 *    由接口守卫的 `requireUser()` 或页面读到的用户会话给出。本文件不读 Cookie、
 *    不知道 `mock_user_id` 的存在，因此「打手身份」在结构上不可能与用户身份分叉。
 * 2. **资格的真值是运行时查出来的**（`Companion` 记录本身），不是登录时写下的一个标记。
 *    每次调用都重新查一遍仓储：下架或移除之后，**下一个请求**就失去权限，
 *    不需要任何会话失效机制。`UserQualificationRecord` 是审核历史与审计记录，
 *    **不是**第二道运行时闸门——两处判定迟早会分叉。
 * 3. **软移除不在这里判断**。「有效护航（已移除的不算）」是
 *    `findCompanionByUser` 的口径，本文件不重复写 `removedAt === null`：
 *    再写一次就是第二个真值来源。
 *
 * ⚠️ 本文件**不认识管理端与客服端的任何东西**：没有从 `adminAuth` / `staffAuth`
 * 引入任何东西，也没有「把管理员或客服换算成打手」的函数。
 */

/** 内部实体 → 工作台 DTO。显式挑字段：`enabled` / `removedAt` / 统计一律不外泄。 */
export function toCompanionSessionUser(
  companion: Companion,
  userId: string,
): CompanionSessionUser {
  return {
    userId,
    companionId: companion.id,
    displayName: companion.displayName,
    avatarUrl: companion.avatarUrl,
  };
}

/**
 * 一个用户的打手访问态 —— 打手工作台的**唯一**读取点。
 *
 * ⚠️ **一次调用 = 一次仓储读取**，而且这次读取同时给出判定与展示所需的字段
 * （`granted` 里的 `rankLabel` 就来自同一条记录）。调用方拿到结果后**不得**
 * 为了补一个字段再查一次：两次 `await` 之间记录可能刚好被下架，于是
 * 「布局按旧记录渲染了工作台壳、内容却取不到资料」——页面停在「顶栏 + 空白」。
 * 这类中间态在测试里极难复现，所以只能靠结构上不可能发生：
 * 本文件只有这一处 `findCompanionByUser`，且工作台路由目录里只有一处调用点
 * （两条都由 `tests/companionAccess.test.mjs` 钉住）。
 *
 * ⚠️ 本函数**不选人**：没有「查谁的资料」这种参数，`userId` 由调用方从会话里取。
 * 因此工作台里不可能出现别人的资料。
 *
 * ⚠️ 两种「不能进」**刻意分开表达**：
 * - `not-a-companion`：没有有效护航资料（含已软移除）；
 * - `disabled`：有资料但被下架——管理员可以恢复，因此页面上必须说清是哪一种，
 *   否则一位被临时下架的打手会以为自己的资格没了，转头去重新提交入驻申请。
 *
 * 与客服端「两种拒绝用同一句话」的取舍不同，是因为两者要说清的事情不同：
 * 客服账号是否启用属于平台内部信息，而「你是不是护航、你的资料在不在架」
 * 这位用户本来就知道。
 *
 * ⚠️ 接口守卫（`lib/api/companionRoute.ts`）与工作台壳层读的是**同一个函数**：
 * 一条规则，一个真值源。守卫只用得上 `companion`，段位对它没有意义，多出来的字段
 * 不会让它多做任何事。
 */
export async function resolveCompanionAccess(userId: string): Promise<CompanionAccessState> {
  const companion = await getCompanionRepository().findCompanionByUser(userId);
  if (!companion) return { kind: "not-a-companion" };

  const session = toCompanionSessionUser(companion, userId);
  if (!companion.enabled) return { kind: "disabled", companion: session };

  // 段位是**展示用**的资料字段；工作台不因此获得任何接单 / 收益能力
  return { kind: "granted", companion: session, rankLabel: companion.rankLabel };
}
