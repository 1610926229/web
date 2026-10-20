/**
 * 服务启动自检（PROD-1E · Phase 6「fail-fast」）。
 *
 * ## 它挡的是什么
 *
 * 半套数据源不会报错，它只会**给出错误的答案**：订单写进了 PostgreSQL，
 * 而某个还没接 Pg 实现的域（排行榜、消费等级、审计……）悄悄读着进程内的 Mock。
 * 页面上一切正常，数字是错的——这种故障没有任何自然信号能把它暴露出来，
 * 因为「读到空列表」和「本来就没有数据」长得一模一样。
 *
 * 因此 `DATA_SOURCE=postgres` 时，服务必须在**能接第一个请求之前**就拒绝启动，
 * 而不是等到某个恰好碰到那个域的请求上才抛错（那时故障已经表现为「某个页面 500」，
 * 与真正的数据错误混在一起，很难归因）。
 *
 * ## 为什么放在 `instrumentation.ts` 而不是路由或布局里
 *
 * `register()` 由 Next 在**每个服务实例启动时调用一次**，并且**必须先完成**
 * 服务才会开始处理请求（见 `node_modules/next/dist/docs/` 的 instrumentation 一节）。
 * 「启动即拒绝」只有这一个位置能做到。放在布局里的自检要等第一个页面渲染才生效，
 * 放在路由里更晚——两者都会先接受若干请求。
 *
 * ## 它与 `getDataSource()` 的关系
 *
 * 两边调用的是**同一个** `assertRepositoriesReadyOnce()`（见 `lib/data/runtime.ts`）：
 *
 * - 这里覆盖 **Route Handler 之前**的整段启动期；
 * - `getDataSource()` 覆盖 **Server Component 取数**那条路径
 *   （它不经过单个仓储访问器，而 Route Handler 路径上 `pickRepository` 会当场抛）。
 *
 * 三层合起来，「一个域漏了 Pg 实现」这件事在三处中的**任何一处**都会被挡住，
 * 而不是只在恰好走到那个域时才暴露。
 *
 * ## 为什么在 Mock 模式下完全没有影响
 *
 * `assertRepositoriesReadyOnce()` 在 `DATA_SOURCE` 不是 `postgres` 时是**空操作**。
 * 未配置 `DATA_SOURCE` 的部署（当前默认）启动行为与本次改动之前逐字节一致。
 *
 * ## 为什么只连**静态清单**，不连数据库
 *
 * 自检检查的是「28 个域各自有没有 Pg 实现」这件**编译期就能知道的事**，
 * 它刻意不查库：数据库连不上是另一类故障（由 `/api/...` 的实际查询暴露，
 * 或由 `pnpm db:health` 回答）。把两件事混在一起会让「服务起不来」有两种完全不同的原因，
 * 排查时反而更慢。
 */

/**
 * `register` 在**每个** runtime 下都会被调用。`pg` 只能跑在 Node 里，
 * 因此把自检限定在 nodejs runtime——另一个 runtime 下这个检查本来就是无意义的
 * （那边没有 `lib/data/pg` 这一套）。用动态 `import()` 也是为了不给非 Node runtime
 * 静态引入 `pg` 相关模块。
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const [{ assertRepositoriesReadyOnce }, { isPostgresDataSourceEnabled }] = await Promise.all([
    import("@/lib/data/runtime"),
    import("@/lib/data/pg/config"),
  ]);

  // 抛错就是**拒绝启动**（`register` 不返回，服务不会开始处理请求）
  assertRepositoriesReadyOnce();

  // 通过时留一行。**只在显式启用 PostgreSQL 时打**：这是运维唯一一处能确认
  // 「这半套数据源是齐的」的地方——没有它，一次成功的自检与一次**没跑**的自检
  // 在日志里长得一模一样，而后者正是这个检查要排除的情况。
  // Mock 模式保持静默：那时自检是空操作，打一行「通过」是在报告一件没发生的事。
  if (isPostgresDataSourceEnabled()) {
    console.log("[datasource] 启动自检通过：全部核心仓储都有 Pg 实现（DATA_SOURCE=postgres）");
  }
}
