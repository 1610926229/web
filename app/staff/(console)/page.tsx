import Link from "next/link";
import { redirect } from "next/navigation";
import StaffRefreshButton from "@/components/staff/StaffRefreshButton";
import {
  STAFF_CONVERSATIONS_PAGE_TITLE,
  STAFF_OVERVIEW_PAGE_TITLE,
} from "@/lib/constants/staff";
import { getStaffOverviewMetrics } from "@/lib/services/staffConversations";
import { getStaffSession } from "@/lib/services/staffAuth";

/**
 * 工作台首页（`/staff`）。
 *
 * 三个数字都是**实时聚合**（会话总数、未读会话数、今日消息数），
 * 不是写死的展示值——验收时要能看着它变。
 *
 * ⚠️ 未读数是**当前登录客服**的口径：换个客服登录，同一个数字会不一样。
 * 因此这里必须用会话里的 `staff.id`，不能从地址栏或查询串里取任何东西。
 *
 * ⚠️ 本页是服务端组件、取数在渲染时发生，因此「刷新」走 `router.refresh()`
 * （`StaffRefreshButton`），而不是客户端再请求一次接口。
 *
 * `getStaffSession()` 在布局里已经执行过一次；这里再执行一次是**有意的重复**：
 * 布局负责「能不能进」，页面负责「以谁的身份取数」。让页面依赖布局传下来的值
 * 需要一套额外的上下文，而多查一次仓储的代价远小于那种耦合。
 */
export default async function StaffOverviewPage() {
  const staff = await getStaffSession();
  // 正常路径上不会到这里（布局已经把匿名请求转走了）。留一条兜底：
  // 少了它，下面每一处 `staff.id` 都要写成可选链，而那会把真正的 bug 藏起来
  if (!staff) redirect("/staff/login");

  const metrics = await getStaffOverviewMetrics(staff.id, undefined, "server");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink">{STAFF_OVERVIEW_PAGE_TITLE}</h1>
          <p className="mt-2 max-w-3xl text-[13px] leading-5 text-ink-3">{metrics.notice}</p>
        </div>
        <StaffRefreshButton />
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard
          label="会话总数"
          value={metrics.conversationCount}
          hint="有沟通记录的订单数"
        />
        <MetricCard
          label="未读会话"
          value={metrics.unreadConversationCount}
          hint="你还有没读的用户或护航消息"
          href="/staff/conversations?unread=1"
          hrefLabel="只看未读"
        />
        <MetricCard
          label="今日消息"
          value={metrics.todayMessageCount}
          hint="北京时间今天的消息条数，含你自己发的"
        />
      </dl>

      <Link
        href="/staff/conversations"
        className="self-start rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white"
      >
        进入{STAFF_CONVERSATIONS_PAGE_TITLE}
      </Link>

      <p className="text-[12px] leading-4 text-ink-3">
        数据生成于 {metrics.generatedAt}。本页不会自动更新，点「刷新」重新取数。
      </p>
    </div>
  );
}

/**
 * 一个数字卡片。
 *
 * 传 `href` 时整张卡片是一个链接——「未读会话 3」后面跟着一句「只看未读」，
 * 比让人自己回到列表页再去勾筛选少两步。
 */
function MetricCard({
  label,
  value,
  hint,
  href,
  hrefLabel,
}: {
  label: string;
  value: number;
  hint: string;
  href?: string;
  hrefLabel?: string;
}) {
  const body = (
    <>
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="mt-1 text-[28px] font-semibold tabular-nums text-ink">{value}</dd>
      <p className="mt-1 text-[12px] leading-4 text-ink-3">{hint}</p>
      {href && hrefLabel ? (
        <span className="mt-2 block text-[12px] text-admin-accent">{hrefLabel} →</span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="rounded-xl border border-admin-line bg-surface px-4 py-3 hover:bg-page"
      >
        {body}
      </Link>
    );
  }

  return (
    <div className="rounded-xl border border-admin-line bg-surface px-4 py-3">{body}</div>
  );
}
