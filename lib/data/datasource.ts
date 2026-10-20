import { isPostgresDataSourceEnabled } from "./pg/config";

/**
 * 数据源选择的**唯一收口**（PROD-1E · Phase 6）。
 *
 * ## 这个文件解决的是哪个问题
 *
 * 在此之前，28 个仓储访问器是**各自硬编码** `return mockXxxRepository;` 的。
 * 要让它们切库，最省事的写法是每个都改成
 * `return isPostgresDataSourceEnabled() ? pgXxxRepository : mockXxxRepository;`——
 * 但那样「这个域到底有没有 Pg 实现」**没有任何人负责检查**：漏写一个访问器、
 * 或者新加一个域时忘记补实现，它在 `DATA_SOURCE=postgres` 下会**静默地继续用
 * Mock**，而所有页面看起来都正常——用户端的订单是真的、排行榜读的却是进程内的
 * 假数据，这种不一致只有靠人偶然比对才能发现（PROD-1E 指令 Phase 5 明令禁止
 * 「silent Mock fallback」，Phase 6 要求「缺实现就在启动或首次 datasource 构造时 fail-fast」）。
 *
 * 收口之后，「有没有 Pg 实现」这件事从**隐式的代码分支**变成**可枚举的数据**：
 * 每个访问器导出一份 `RepositoryBacking`（`{ name, mock, pg }`），`pg` 为 `null`
 * 就字面意思地表示「这个域还没有 Pg 实现」，而 `lib/data/runtime.ts` 持有全部
 * 28 份的清单、逐个检查。
 *
 * ## 什么时候检查
 *
 * ⚠️ **只在 `DATA_SOURCE=postgres` 时检查**，Mock 模式下这些检查一次都不跑。
 *
 * 这是刻意的，理由是「Mock 行为是本轮的迁移语义基线」（Phase 4）：Mock 模式下
 * 缺 Pg 实现**无害**（`pickRepository` 反正返回 Mock），而让它抛错会把一次
 * 「清单漏登记」变成**开发环境起不来**——那是一个与本次改动无关的行为变更。
 * 真正的 fail-fast 落点是**启用 PostgreSQL 的那一刻**，也正是这个检查要保护的时刻。
 *
 * ⚠️ 代价要写清楚：Mock 模式（= 全部既有测试的运行模式）**跑不到这两个断言**。
 * 因此「清单是完整的 28 条」这件事目前由 `runtime.ts` 的 import 列表 + 本文件的
 * `CORE_REPOSITORY_COUNT` 在**激活路径**上保证，而不是由测试保证。
 */

/**
 * 仓储的两种后端实现。
 *
 * `pg: null` 是**合法值**——它表示「这个域还没有 Pg 实现」，而不是「忘了填」。
 * 把一个不存在的实现写成 `undefined` 再靠 `!== undefined` 去判，会让
 * 「漏写」与「明确没有」长得一模一样；`null` 是显式的。
 */
export type RepositoryBacking<T> = {
  /** 域的名字。只用于错误信息与清单，不参与任何判定 */
  name: string;
  mock: T;
  /** `null` = 这个域还没有 Pg 实现。在 `DATA_SOURCE=postgres` 下会被 fail-fast 抓住 */
  pg: T | null;
};

/**
 * 在 `DATA_SOURCE=postgres` 下取用一个没有 Pg 实现的仓储时抛出。
 *
 * ⚠️ **故意不是**「回退到 Mock」：那正是 Phase 5 禁止的静默 fallback。
 * 一个半真半假的系统——订单在库里、等级配置在进程里——比一个起不来的系统
 * 危险得多，因为前者的表现是「页面正常，数据是错的」。
 */
export class MissingPgImplementationError extends Error {
  readonly repositoryName: string;

  constructor(repositoryName: string) {
    super(
      `数据源配置为 PostgreSQL，但仓储「${repositoryName}」没有 Pg 实现。` +
        "半套数据源（部分走库、部分走进程内 Mock）已被明令禁止；" +
        "请补齐该仓储的 Pg 实现，或把 DATA_SOURCE 改回 mock。",
    );
    this.name = "MissingPgImplementationError";
    this.repositoryName = repositoryName;
  }
}

/**
 * 全部核心仓储的数量。**它是清单完整性检查的基准**。
 *
 * ⚠️ 写死一个数字而不是 `backings.length`：后者永远等于自己，检查不出
 * 「`runtime.ts` 少 import 了一个域」。加第 29 个仓储时，这个数字与
 * `lib/data/runtime.ts` 的清单要**一起**改——少改一处就会在激活时抛错。
 */
export const CORE_REPOSITORY_COUNT = 28;

/**
 * 取用某个域的仓储。
 *
 * 每个访问器都只做一件事：把自己那一份 backing 交给这个函数。
 * `DATA_SOURCE=postgres` 且 `pg` 为 `null` 时**立刻抛错**，不返回 Mock。
 */
export function pickRepository<T>(backing: RepositoryBacking<T>): T {
  if (!isPostgresDataSourceEnabled()) return backing.mock;
  if (!backing.pg) throw new MissingPgImplementationError(backing.name);
  return backing.pg;
}

/**
 * 清单自检：全部核心仓储都有 Pg 实现，且清单没有被漏掉一条。
 *
 * 由 `lib/data/runtime.ts` 在 `getDataSource()` 首次调用时跑一次（memoized）。
 * 它覆盖的是 **Server Component 路径**——那条路径不经过单个访问器；
 * Route Handler 路径则由各访问器自己的 `pickRepository` 即时守卫。
 * 两条路径合起来，`DATA_SOURCE=postgres` 下不存在「悄悄用了 Mock」的缝。
 */
export function assertAllRepositoriesWired(
  backings: readonly RepositoryBacking<unknown>[],
): void {
  if (!isPostgresDataSourceEnabled()) return;

  const missing = backings.filter((backing) => backing.pg === null).map((backing) => backing.name);
  if (missing.length > 0) {
    // 一次把**全部**缺的域报出来，而不是第一个就停：逐个修的人要跑 28 次
    // 才能知道自己还差几个，而这不是一个需要「先修上游」的依赖链。
    throw new Error(
      `数据源配置为 PostgreSQL，但以下 ${missing.length} 个仓储没有 Pg 实现：` +
        `${missing.join("、")}。半套数据源已被明令禁止。`,
    );
  }

  if (backings.length !== CORE_REPOSITORY_COUNT) {
    throw new Error(
      `核心仓储清单有 ${backings.length} 条，但 CORE_REPOSITORY_COUNT = ${CORE_REPOSITORY_COUNT}。` +
        "新增或删除仓储时，lib/data/runtime.ts 的清单与本常量必须一起更新。",
    );
  }
}
