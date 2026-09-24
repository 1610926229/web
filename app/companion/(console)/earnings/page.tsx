import CompanionEarningList from "@/components/companion/CompanionEarningList";
import PriceText from "@/components/common/PriceText";
import { getSessionUser } from "@/lib/auth/session";
import {
  COMPANION_EARNINGS_PAGE_TITLE,
  EARNING_STATUS_LABELS,
} from "@/lib/constants/earnings";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { listCompanionEarnings } from "@/lib/services/companionEarnings";

/**
 * 我的收益（P0-9）—— **我这一单挣了多少**、这笔钱现在能不能用。
 *
 * ## 首屏由本页直接取数，不经过 HTTP 请求自己的接口
 *
 * 与「我的订单」页（`app/companion/(console)/orders/page.tsx`）同一个取舍：
 * Server Component 直连服务层 `listCompanionEarnings()`，避免构建期自请求与多一跳网络。
 * 本页**没有写操作**，因此连浏览器端的请求路径都不需要存在：
 * `app/api/companion/earnings/route.ts` 提供的是同一个只读结果（同一个服务函数），
 * 但它是给**接口调用方**的入口，不是本页的数据来源——页面自己再请求一次自己，
 * 只会多一跳网络与一份可能不一致的结果。
 *
 * ## 归属只由服务端回答
 *
 * `listCompanionEarnings(companionId)` 以**当前登录打手的 id** 当查询条件
 * （不是「查出来再比对」），因此这一页在结构上只能显示他自己的收益。
 * ⚠️ 页面这一层无法、也不该再做一次归属过滤——那就等于给同一条规则开第二个出处。
 *
 * ## 这一页**没有任何写入口**
 *
 * 没有提现、没有冲正、没有罚款：P0-9 只做「看得见」，提现不在本阶段范围内。
 * 这里刻意**不放一个点了没反应的提现按钮**——`EarningStatus` 上写着 `withdrawn` /
 * `reversed` 两个取值，但它们在当前批次**没有写入路径**，页面也就不该承诺一个动作。
 *
 * ## 为什么这一页自己读资格
 *
 * 取自己的收益需要**当前打手的 id**，而 Next 的布局无法给 `children` 传 props。
 * 「那不就是查了两次资格？」——不是：`getSessionUser` 与 `resolveCompanionAccess`
 * 都被 `React.cache` 包着，一次请求内两次调用返回同一个结果（同一理由见 `orders/page.tsx`）。
 * 布局拿不到资格时已经渲染了提示页并**不渲染本页**，这里的分支只是兜底。
 *
 * ⚠️ 页面上**除了收益金额本身，一个订单金额都没有**：用户实付、平台净收入、分账比例
 * 都不在打手端 DTO 上，这一页也就无从显示（见 `lib/types/earning.ts` 的 DTO 注释）。
 */
export default async function CompanionEarningsPage() {
  const user = await getSessionUser();
  // 未登录时布局已经在渲染用户端的登录控件；这里什么都不做
  if (!user) return null;

  const access = await resolveCompanionAccess(user.id);
  // 不是护航 / 资格已下架：布局已经渲染了对应的提示页
  if (access.kind !== "granted") return null;

  const data = await listCompanionEarnings(access.companion.companionId);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold text-ink">{COMPANION_EARNINGS_PAGE_TITLE}</h2>
        {/* 说明文案由服务端给（`data.notice`）：它要同时说清「为什么冻结」与
            「什么时候解冻」，而这两句依赖平台参数，页面自己拼会把规则写成两份 */}
        <p className="rounded-xl border border-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
          {data.notice}
        </p>
      </div>

      {/* 冻结与可提现**分开列**，不合成一个「总收益」：合起来会让打手以为冻结中的钱现在就能用 */}
      <dl className="flex gap-3">
        <SummaryCell label={EARNING_STATUS_LABELS.frozen} cents={data.summary.frozenAmount} />
        <SummaryCell label={EARNING_STATUS_LABELS.available} cents={data.summary.availableAmount} />
      </dl>

      <CompanionEarningList items={data.items} />
    </>
  );
}

/**
 * 合计里的一格。
 *
 * ⚠️ 两个标签直接取 `EARNING_STATUS_LABELS`：合计的桶名与状态名是**同一件事**
 * （「冻结中」那一格加起来的就是 `status === "frozen"` 的记录），各写一句文案迟早对不上。
 *
 * ⚠️ 金额走 `PriceText`，也就是 `lib/utils/format.ts` 的 `formatYuan`
 * ——两位小数的口径全站只有那一处实现。
 */
function SummaryCell({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-line px-4 py-3">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-1">
        <PriceText cents={cents} className="text-[18px] text-ink" />
      </dd>
    </div>
  );
}
