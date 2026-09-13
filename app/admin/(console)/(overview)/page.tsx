import AdminMetricCards from "@/components/admin/AdminMetricCards";
import { ADMIN_OVERVIEW_PAGE_TITLE } from "@/lib/constants/admin";
import { getAdminOverview } from "@/lib/services/adminConsole";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 后台概览（`/admin`）。
 *
 * 七个数字全部由 `getAdminOverview()` 从**当前仓储**聚合出来，页面不做任何计算、
 * 不写死任何展示值：用户端新提交一条入驻申请，刷新这里「待审核申请」就会变。
 *
 * 状态齐了四档，正是本阶段要求的四条：
 * - 加载态：同段 `loading.tsx`（侧栏与顶部条由布局渲染，不跟着闪）；
 * - 错误态与重试：同段 `error.tsx` → `ErrorState`；
 * - 空数据安全降级：数字本来就是 0（对后台而言「没有待审核」是有效信息，不是异常），
 *   全部为 0 时额外补一句说明，避免看到一排 0 时以为页面坏了；
 * - 点击进入对应列表筛选：每张卡的 `href` 由服务端给出，页面不自己拼地址。
 *
 * ⚠️ 本页**只读**：不提供任何审核、启用、停用入口——那些动作属于入驻审核与护航管理模块。
 * ⚠️ 调试参数（`?mockError` / `?mockEmpty`）在**服务层**处理，本页只把 `searchParams`
 * 交进去，因此页面组件不引用 `lib/mocks/*`，与用户端同一条分层规则。
 */
export default async function AdminOverviewPage({ searchParams }: PageProps<"/admin">) {
  const params = toSearchParams(await searchParams);
  const overview = await getAdminOverview(params);

  const allZero = overview.metrics.every((metric) => metric.value === 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[20px] font-semibold text-ink">{ADMIN_OVERVIEW_PAGE_TITLE}</h1>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{overview.notice}</p>
      </div>

      <AdminMetricCards
        metrics={overview.metrics}
        emptyHint={
          allZero
            ? "当前全部指标为 0：本地 Mock 数据可能已被清空（开发服务器重启会回到预置数据），也可能确实还没有申请与护航记录。"
            : null
        }
      />

      <p className="text-[12px] leading-5 text-ink-3">
        数据生成时间：{overview.generatedAt}（服务端时间，每次刷新都会更新）
      </p>
    </div>
  );
}
