import AdminDashboardBoard from "@/components/admin/AdminDashboardBoard";
import AdminMetricCards from "@/components/admin/AdminMetricCards";
import AdminQuickEntries from "@/components/admin/AdminQuickEntries";
import { ADMIN_OVERVIEW_CUMULATIVE_TITLE, ADMIN_OVERVIEW_PAGE_TITLE } from "@/lib/constants/admin";
import { getAdminDashboard } from "@/lib/services/adminDashboard";
import { getAdminOverview } from "@/lib/services/adminConsole";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 管理后台经营首页（`/admin`）—— **P1-1 把这里从「入口页」升级为经营首页**。
 *
 * 从上到下四段，顺序即优先级：
 *
 * 1. **今日经营**（今日订单 / 今日 GMV / 今日退款）：当天做成了多少。
 * 2. **当前待办**（申请 / 退款 / 投诉）：今天有什么事等着管理员处理。
 * 3. **快捷入口**：去各个模块的常用路径（清单来自 `ADMIN_NAV_ITEMS`，没有假入口）。
 * 4. **申请与护航规模（全量累计）**：原来那七个数字，**与日期无关**。
 *
 * ⚠️ 第 4 段**必须带「全量累计」的标题**：它与第 1 段的「今日」同屏，
 * 不加限定词就会被读成「今天新增」。这正是 `ADMIN_OVERVIEW_NOTICE` 要同时说清两件事的原因。
 *
 * ⚠️ 两次取数**并发**发出（一次 `Promise.all`）：它们是彼此独立的两组查询，
 * 串行只会让首屏白等一个模拟延迟。两组各自处理 `searchParams`，
 * 因此 `?mockError=1` 会让整页走 `error.tsx`，`?mockEmpty=dashboard` 只清零第一段。
 *
 * ⚠️ 本页**只读**：没有任何审核、退款、换人、改状态的入口——那些动作属于各自的模块页，
 * 首页只负责「聚合 / 展示 / 跳转」。调试参数（`?mockError` / `?mockEmpty`）在**服务层**
 * 处理，本页只把 `searchParams` 交进去，因此页面组件不引用 `lib/mocks/*`。
 *
 * 状态齐了四档：加载态同段 `loading.tsx`（侧栏与顶部条由布局渲染，不跟着闪）；
 * 错误态与重试 `(console)/error.tsx` → `ErrorState`，或经营首页内部的局部重试；
 * 「全 0」是**正常**经营首页，只有一句说明，不整页空态；每张卡都能点进对应列表。
 */
export default async function AdminOverviewPage({ searchParams }: PageProps<"/admin">) {
  const params = toSearchParams(await searchParams);
  const [dashboard, overview] = await Promise.all([
    getAdminDashboard(params),
    getAdminOverview(params),
  ]);

  const allZero = overview.metrics.every((metric) => metric.value === 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[20px] font-semibold text-ink">{ADMIN_OVERVIEW_PAGE_TITLE}</h1>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{overview.notice}</p>
      </div>

      <AdminDashboardBoard initialDashboard={dashboard} />

      <AdminQuickEntries />

      <section className="flex flex-col gap-3">
        <h2 className="text-[16px] font-semibold text-ink">{ADMIN_OVERVIEW_CUMULATIVE_TITLE}</h2>

        <AdminMetricCards
          metrics={overview.metrics}
          emptyHint={
            allZero
              ? "本组全部为 0：本地 Mock 数据可能已被清空（开发服务器重启会回到预置数据），也可能确实还没有申请与护航记录。"
              : null
          }
        />
      </section>

      <p className="text-[12px] leading-5 text-ink-3">
        数据生成时间：{overview.generatedAt}（服务端时间，每次刷新都会更新）
      </p>
    </div>
  );
}
