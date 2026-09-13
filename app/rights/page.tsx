import NavBar from "@/components/common/NavBar";
import LevelListView from "@/components/rights/LevelListView";
import LevelSummaryCard from "@/components/rights/LevelSummaryCard";
import PrivilegeList from "@/components/rights/PrivilegeList";
import RequireAuth from "@/lib/auth/RequireAuth";
import {
  LEVEL_CALCULATION_TITLE,
  LEVEL_PAGE_TITLE,
  LEVEL_PRIVILEGE_SECTION_TITLE,
  LEVEL_PRIVILEGE_NOTICE,
} from "@/lib/constants/levels";
import { getConsumptionLevelForUser } from "@/lib/services/levels";
import type { User } from "@/lib/types/user";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 消费等级与权益（**需登录**）。
 *
 * 二级页面：在 `(tabs)` 之外，顶部返回、**不带底部 TabBar**。NavBar 放在 `RequireAuth`
 * 外面，未登录时也能返回上一页；登录后地址仍是 `/rights`，不会把人甩到别处。
 *
 * 页面只做两件事：把服务端算好的 `ConsumptionLevelSummary` 画出来，以及把口径说明原样展示。
 * **不遍历订单、不比较阈值、不推导下一等级**——这些都只在 `lib/constants/levels.ts` 里做一次。
 *
 * 页面能看到的只有 DTO：订单明细、游戏 ID、备注、退款原因都不在 DTO 里，
 * 因此不可能顺着页面泄漏出去。
 */
export default async function RightsPage({ searchParams }: PageProps<"/rights">) {
  const params = toSearchParams(await searchParams);

  return (
    <>
      <NavBar title={LEVEL_PAGE_TITLE} showBack />

      <RequireAuth>
        {(user) => <RightsBody user={user} params={params} />}
      </RequireAuth>
    </>
  );
}

async function RightsBody({
  user,
  params,
}: {
  user: User;
  params: URLSearchParams;
}) {
  // 首屏在服务端直接取数（不走自己的 HTTP 接口），因此没有加载闪烁；
  // Mock 参数原样传下去，`?mockEmpty=levels` 才能演示「等级配置暂不可用」。
  const summary = await getConsumptionLevelForUser(user.id, params, "server");

  return (
    <div className="flex flex-1 flex-col bg-page">
      <div className="mine-hero px-4 pb-12 pt-4">
        <LevelSummaryCard
          summary={summary}
          nickname={user.nickname}
          avatarUrl={user.avatarUrl}
          tone="hero"
        />
      </div>

      {/* 圆角白纸上浮压住深色卡下沿，与「我的」页同一套分层做法 */}
      <div className="-mt-6 flex flex-1 flex-col gap-4 rounded-t-[24px] bg-surface px-4 pb-8 pt-5">
        <section className="flex flex-col gap-2">
          <h2 className="text-[15px] font-semibold text-ink">{LEVEL_PRIVILEGE_SECTION_TITLE}</h2>
          {summary.available && summary.currentLevel ? (
            <>
              <p className="text-[12px] leading-5 text-ink-3">
                当前等级：{summary.currentLevel.name}
              </p>
              <PrivilegeList privileges={summary.currentLevel.privileges} />
            </>
          ) : (
            // 配置不可用时**不给权益**：编一份权益清单比不给更糟
            <p className="rounded-[10px] border border-line px-3 py-4 text-[13px] leading-5 text-ink-3">
              {summary.unavailableReason}
            </p>
          )}
          <p className="text-[11px] leading-4 text-ink-3">{LEVEL_PRIVILEGE_NOTICE}</p>
        </section>

        <LevelListView
          levels={summary.levels}
          currentLevelId={summary.currentLevel ? summary.currentLevel.id : null}
        />

        <section className="flex flex-col gap-2 rounded-[10px] bg-page p-3">
          <h2 className="text-[13px] font-semibold text-ink">{LEVEL_CALCULATION_TITLE}</h2>
          <p className="text-[12px] leading-5 text-ink-2">{summary.calculationNotice}</p>
          {/* 「当前为 Mock 配置」这句必须出现，否则用户会把示例等级当成平台规则 */}
          <p className="text-[12px] leading-5 text-ink-3">{summary.configNotice}</p>
        </section>
      </div>
    </div>
  );
}
