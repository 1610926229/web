import { ApiError } from "@/lib/api/ApiError";
import { requireUser } from "@/lib/api/route";
import {
  COMPANION_DISABLED_MESSAGE,
  COMPANION_NOT_A_COMPANION_MESSAGE,
} from "@/lib/constants/companionConsole";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import type { CompanionSessionUser } from "@/lib/types/companionWorkspace";

/**
 * 打手接口的鉴权守卫（仅服务端使用）。
 *
 * ⚠️ 与 `requireUser()` / `requireAdmin()` / `requireStaff()` **并列而不是复用**：
 * 打手身份的来源与前两者不同——它**建立在用户会话之上**，而不是自己的会话。
 *
 * ## 打手身份是怎么来的
 *
 * ```
 * requireUser()            →  userId（用户会话，与「我的订单」同一个身份）
 * resolveCompanionAccess() →  这个用户名下有没有一条有效的、已上架的护航资料
 * ```
 *
 * **到此为止**。没有打手 Cookie、没有打手登录页、没有打手认证接口，
 * 也没有独立的会话模块与开关：一个人是不是打手，完全由他名下的护航资料决定，
 * 而资料什么时候被下架，权限就什么时候消失（每次请求都重新查一遍）。
 *
 * 「同一个人可以既是老板又是打手」这条产品决定，在这里表现为
 * **不需要任何身份切换**：同一个用户会话，走用户端接口时是老板，走打手接口时是打手。
 *
 * ## 身份矩阵
 *
 * | 带来的 Cookie | 结果 | 为什么 |
 * | --- | --- | --- |
 * | 什么都没有 | 401 | 未登录（由 `requireUser()` 给出） |
 * | `mock_user_id`，名下没有有效护航资料 | 403 | 登录了，但不是打手 |
 * | `mock_user_id`，护航资料已下架 | 403 | 是打手，但资格当前不可用 |
 * | `mock_user_id`，护航资料正常 | 通过 | —— |
 * | `mock_admin_id` / `mock_staff_id` | 401 | 本守卫只读用户会话；别的身份压根不在取值范围内 |
 *
 * 最后一行不是靠额外判断实现的，而是因为 `requireUser()` 只读用户端 Cookie：
 * 管理端或客服端的会话**不构成**打手权限，反之亦然。
 *
 * ⚠️ **每一个打手接口都必须自己调用本函数，而且必须是第一步**。
 * 页面上的隐藏区不构成保护——接口是可以被直接请求的。
 *
 * ⚠️ 两种拒绝**分开表达**（与客服端「两种拒绝用同一句话」的取舍不同）：
 * 「不是护航」要引导去入驻，「资格已下架」要引导去找管理员，这两件事对使用者的
 * 下一步动作完全不同，合成一句会让人对着「你没有权限」不知道该做什么。
 * 这不构成账号探测：这两件事这位用户自己本来就知道。
 *
 * ⚠️ P0-4 阶段**还没有任何打手接口**调用本函数：它是本批次交付的核心能力，
 * 第一个真实调用方是 P0-5 的接单接口。在此之前它由
 * `tests/companionAccess.test.mjs` 的隔离断言守住（必须走 `requireUser()`，
 * 且访问判定只有 `resolveCompanionAccess()` 一处）。
 */
export async function requireCompanion(): Promise<CompanionSessionUser> {
  // 身份来源：既有的用户会话。未登录会在这里拿到 401，与会话机制完全一致
  const user = await requireUser();

  // ⚠️ 判定委托给服务层，本函数**不自己查仓储**：
  // 这里再写一次「有没有资料 / 有没有下架」，就会出现第二个真值来源，
  // 而分叉的那一天，「已被移除的护航」会以「资格已下架」出现在接口响应里
  const state = await resolveCompanionAccess(user.id);

  if (state.kind === "not-a-companion") {
    throw new ApiError("FORBIDDEN", COMPANION_NOT_A_COMPANION_MESSAGE, 403);
  }
  if (state.kind === "disabled") {
    throw new ApiError("FORBIDDEN", COMPANION_DISABLED_MESSAGE, 403);
  }

  return state.companion;
}
