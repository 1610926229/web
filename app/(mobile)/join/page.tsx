import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import CompanionApplicationForm from "@/components/companions/CompanionApplicationForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import {
  COMPANION_APPLICATION_EXISTING_HINTS,
  COMPANION_APPLICATION_STATUS_CLASS,
  COMPANION_JOIN_PAGE_TITLE,
} from "@/lib/constants/companionApplications";
import {
  getMyCompanionApplicationSummary,
  listCompanionApplicationGameOptions,
} from "@/lib/services/companionApplications";
import type { CompanionApplicationSummary } from "@/lib/types/companionApplication";
import { formatDateTime } from "@/lib/utils/format";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 成为护航（考核入驻）。**进入前必须登录**。
 *
 * 两个入口都指向这里：首页「考核入驻」与「我的」页「成为护航」——同一个功能只留一个地址。
 * 未登录时由统一的 `RequireAuth` 渲染登录引导，地址保持 `/join` 不变，
 * 登录成功后服务端重新渲染本页，用户直接落在这里，不会被弹回首页。
 *
 * 导航栏渲染在鉴权**之外**：未登录时也要有返回入口，不能把人困在登录页上。
 * 本页在 `(tabs)` 之外，属于二级页面，因此只有顶部返回、没有底部 TabBar。
 *
 * **一个人最多一条申请**，所以这一页有两种形态：
 * - 还没有申请 → 渲染申请表单；
 * - 已有申请 → **不再渲染表单**，只显示「到哪一步了」并引导去 `/join/status`。
 *   四种已有状态（待查看 / 审核中 / 已通过 / 未通过 / 已撤销）里，**一个都不给重新提交的入口**：
 *   重新申请规则尚未确认，给按钮就是在自行发明规则。
 *
 * 这里读的是**申请摘要 DTO**（只有状态、单号与时间）：表单内容与凭证不进这一页，
 * 这一页也不需要它们。
 *
 * 页面里没有任何「模拟通过 / 模拟拒绝」入口，也没有审核 API——
 * 审核结果与用户角色、接单权限之间的关系尚未确认，本阶段不提前实现。
 */
export default async function JoinPage({ searchParams }: PageProps<"/join">) {
  const query = toSearchParams(await searchParams);

  return (
    <>
      <NavBar title={COMPANION_JOIN_PAGE_TITLE} showBack />

      <RequireAuth>
        {(user) => <JoinBody userId={user.id} query={query} />}
      </RequireAuth>
    </>
  );
}

/** 已完成登录后才有意义的内容：先看有没有申请，再决定是表单还是进度引导。 */
async function JoinBody({ userId, query }: { userId: string; query: URLSearchParams }) {
  const summary = await getMyCompanionApplicationSummary(userId, query, "server");

  if (summary) return <ExistingApplication summary={summary} />;

  const games = await listCompanionApplicationGameOptions();

  return (
    <div className="flex flex-1 flex-col overflow-x-clip">
      <CompanionApplicationForm games={games} />
    </div>
  );
}

/** 已有申请：只说清现状，不给重新提交的入口。 */
function ExistingApplication({ summary }: { summary: CompanionApplicationSummary }) {
  return (
    <div className="flex flex-1 flex-col bg-page pb-8">
      <section className="bg-surface px-4 py-4">
        <p className={`text-[18px] font-semibold ${COMPANION_APPLICATION_STATUS_CLASS[summary.status]}`}>
          {summary.statusLabel}
        </p>
        <p className="mt-1 text-[13px] leading-5 text-ink-3">
          {COMPANION_APPLICATION_EXISTING_HINTS[summary.status]}
        </p>

        <div className="mt-3 rounded-[10px] border border-line px-3 py-2.5">
          <Row label="申请单号" value={summary.applicationNo} />
          <Row label="提交时间" value={formatDateTime(summary.submittedAt)} />
        </div>
      </section>

      <div className="mt-3 px-4">
        <Link
          href="/join/status"
          className="flex h-11 w-full items-center justify-center rounded-full bg-brand-blue text-[15px] font-medium text-white"
        >
          查看入驻进度
        </Link>
        <p className="mt-2 text-[12px] leading-4 text-ink-3">
          一个人同时只能有一条入驻申请，因此这里不再显示申请表单。
        </p>
      </div>
    </div>
  );
}

/** 明细行：左标签右内容，长内容换行而不是把卡片撑宽。 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-right text-ink">{value}</span>
    </div>
  );
}
