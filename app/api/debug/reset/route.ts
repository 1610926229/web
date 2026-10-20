import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { isMockDebugEnabled } from "@/lib/config/env";
import { resetMockStores } from "@/lib/services/mockStores";

/**
 * 把**服务进程里**的全部 Mock 存储丢回预置数据。
 *
 * ## 它为什么存在
 *
 * 这份存储是**进程内**的：`next start` 起的服务在建仓时写入预置数据，
 * 之后所有读写都发生在这份内存里，**重启即回到预置状态**。自动化测试里有一批
 * HTTP 用例会真的去改它（下单、退款、建券……），而这些改动**只增不减**——
 * 服务跑得越久，存储就离预置状态越远。
 *
 * 进程内的用例不受影响：`node --test` 让每个测试文件跑在自己的子进程里，
 * 文件之间天然隔离（`resetMockStore()` 换掉的正是**本进程**的存储）。
 * 但 HTTP 用例打的是**另一个进程**，测试进程里的 `resetMockStore()` 够不着它——
 * 于是「这一批 HTTP 用例跑之前，服务是什么状态」就只靠**约定**：
 * 文件头写「请先重启服务」，没有任何东西强制它。
 *
 * 这个接口把那条约定的**自动化**：HTTP 测试文件在开跑前 POST 一次，
 * 服务端把整族存储丢回预置。于是每个 HTTP 文件都从「刚重启的服务」出发，
 * 而不是从「前面几十个文件攒下来的状态」出发。
 *
 * ## 守卫为什么是「开关 404」而不是 `requireAdmin()`
 *
 * `api-contract.md` §2.1 第 1 条要求「每个接口必须自己调用守卫，而且必须是第一步」。
 * 本接口的守卫就是**第一步**的那三行：`ENABLE_MOCK_DEBUG` 未开启 → 404。
 * 没有再加 `requireAdmin()`，理由是**加了只会让事情更糟**：
 * 这个接口的唯一调用方是 24 个 HTTP 测试文件的模块加载期，它们各自用不同的身份
 * （用户 / 客服 / 打手 / 管理员）登录。要求管理员身份会逼着每个文件先登一次管理员，
 * 把「测试环境需要 `ENABLE_MOCK_ADMIN`」变成一条新的隐式前置——而**它挡不住任何东西**：
 * 能读到这个接口的人，本来就已经能直接访问同一台机器上的全部 Mock 调试能力
 * （`mockEmpty` / `mockError` / `mockDelay`），能写库的管理端接口也一个都不缺。
 * 真正的边界是**这个接口只存在于开着 `ENABLE_MOCK_DEBUG` 的进程里**，
 * 而那个开关的前提（L4）是不开在有真实数据的部署上。
 *
 * ## 安全边界
 *
 * - **POST only**：本文件不导出 `GET`。清空数据不能被一个链接、一次预取触发。
 * - **由 `ENABLE_MOCK_DEBUG` 总开关控制**：未开启时整个接口返回 **404**
 *   （「接口不存在」，而不是 403），与 `/api/payments/mock-confirm`、
 *   `/api/auth/mock-login` 同一取舍——`api-contract.md` §2.2 那两个「刻意使用 404」的场景。
 *   正式部署不设置这个变量即可。
 *
 *   ⚠️ 说清楚它的**代价**：在**开**着 `ENABLE_MOCK_DEBUG` 的环境里，任何能访问该服务的人
 *   都能把 Mock 数据清空。这在本地开发与自动化测试里是可接受的（数据本来就是内存里的、
 *   重启就没了的一次性数据），但意味着**这个开关不能开在任何一个有真实数据的部署上**——
 *   这一点与 `mockEmpty` / `mockError` 等既有调试能力是**同一个**前提，不是新增的风险面。
 *
 * ## 它不做什么
 *
 * 不碰真实数据库（没有），不碰会话 Cookie（登录态与数据存储是两回事，
 * 被这条接口清掉的只有各类 Mock 仓储）。将来换成真数据库时，这个文件应当**直接删除**——
 * 真实测试应当用独立的测试库，而不是给线上服务开一个清库接口。
 */
export async function POST() {
  if (!isMockDebugEnabled()) {
    return fail(new ApiError("NOT_FOUND", "调试接口未启用", 404));
  }

  try {
    // 返回被丢弃的 store 名：调用方（测试）据此确认「确实重置了、重置了哪些」，
    // 而不是拿到一个 200 就假设成功。
    const reset = resetMockStores();
    return ok({ reset });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
