import { resetAllMockStores } from "@/lib/data/mockStore";

/**
 * Mock 存储的生命周期操作 —— **只服务 `POST /api/debug/reset`（测试专用）**。
 *
 * ## 为什么这层薄得只有一行
 *
 * 它存在**不是为了装业务**，而是为了不破分层：`architecture-rules.md` §2.1 明令
 * 「`app/` 与 `components/` 不得直接 import `lib/data`」，而且 §六 写得很清楚——
 * **未来新增代码不得以「仓库里已经这样了」为由模仿既有破例**。
 * `/api/auth/mock-login` 直接调 `lib/data/userRepository` 是已登记的历史破例
 * （见 `api-contract.md` 的 Route 清单），**不是可以照着做的范例**。
 *
 * 所以在 `app/api/debug/reset/route.ts` 与 `lib/data/mockStore.ts` 之间放这一个转发：
 * Route 只调 service，`lib/data` 只被 service 碰。规则里的「唯一破例」因此仍然是**唯一**的。
 *
 * ## 它不是什么
 *
 * - **不是业务服务**：不碰订单、金额、状态机、权限；不读也不写任何业务数据。
 * - **不是给生产用的**：接真实后端时，`app/api/debug/reset/route.ts` 与这个文件应当
 *   一起**直接删除**——真实测试该用独立的测试库，而不是给线上服务开一个清库接口。
 * - **不校验开关**：`ENABLE_MOCK_DEBUG` 的判断在 Route 里（守卫是边界层的职责，
 *   见 `api-contract.md` §2.1 第 1 条）。这一层不做二次判断，避免同一条件散落两处。
 */

/**
 * 把当前进程里的**全部** Mock 存储丢弃，使下一次 `getMockStore()` 重新跑 seed。
 *
 * @returns 被丢弃的 store 名。调用方（测试）据此确认「确实重置了、重置了哪些」，
 *          而不是拿到一个 200 就假设成功。
 *
 * ⚠️ **只作用于本进程。** 它是 `resetMockStore` 的整族版本，作用域同样限于
 * 调用者所在的 `globalThis`。`node --test` 的测试进程够不着 `next start` 的进程——
 * HTTP 用例必须走 `POST /api/debug/reset` 才能重置服务端，这也正是那个接口存在的理由。
 */
export function resetMockStores(): string[] {
  return resetAllMockStores();
}
