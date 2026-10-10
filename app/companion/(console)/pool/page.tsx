import CompanionDispatchTable from "@/components/companion/CompanionDispatchTable";
import { getSessionUser } from "@/lib/auth/session";
import {
  COMPANION_POOL_PAGE_TITLE,
  COMPANION_PUBLIC_EMPTY,
  COMPANION_PUBLIC_EMPTY_PAUSED,
} from "@/lib/constants/dispatch";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { listCompanionPools } from "@/lib/services/companionDispatch";

/**
 * 公共订单池（P0-5）：谁都能接的单。
 *
 * ## 这一页为什么自己读资格，而不是让布局把结果传下来
 *
 * 页面要拿**当前打手的 id** 才能取自己的池子（专属池按他收窄、公共池的每一条
 * 都要对着他判定可不可接）。Next 的布局无法给 `children` 传 props，
 * 因此页面必须自己拿到这份身份。
 *
 * 「那不就是查了两次资格？」——不是。`resolveCompanionAccess` 与 `getSessionUser`
 * 都被 `React.cache` 包着（见 `lib/services/companionAccess.ts`）：
 * **一次请求内两次调用返回的是同一个结果**，仓储只读一次。
 * 「一次渲染只有一份资格结果」这条约束因此仍然成立。
 *
 * 布局拿不到资格时会渲染提示页（还不是护航 / 资格已下架），并且**不渲染本页**；
 * 这里的分支只是兜底，返回 null 而不是再画一个提示——两处都画会出现两个提示页。
 *
 * ⚠️ 页面**不做任何接单判定**：能不能接由接口（`acceptDispatch` 的原子区段）说了算，
 * 页面只负责显示。列表里的剩余时间也一样，只是服务端算好的一个数。
 *
 * ⚠️ 顶部那句说明与「有没有接单按钮」都取自 `pools`（`notice` / `canAccept`），
 * **页面不自己拼**：暂停接单（`available = false`）时这句话要换成暂停的那句，
 * 空态也要换成暂停的那句——沿用默认文案会与「公共池一条都不返回」自相矛盾。
 */
export default async function CompanionPoolPage() {
  const user = await getSessionUser();
  // 未登录时布局已经在渲染用户端的登录控件；这里什么都不做
  if (!user) return null;

  const access = await resolveCompanionAccess(user.id);
  // 不是护航 / 资格已下架：布局已经渲染了对应的提示页
  if (access.kind !== "granted") return null;

  const pools = await listCompanionPools(access.companion.companionId, new Date().toISOString());

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold text-ink">{COMPANION_POOL_PAGE_TITLE}</h2>
        <p className="rounded-xl border border-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
          {pools.notice}
        </p>
      </div>

      <CompanionDispatchTable
        items={pools.public}
        canAccept={pools.canAccept}
        emptyText={pools.canAccept ? COMPANION_PUBLIC_EMPTY : COMPANION_PUBLIC_EMPTY_PAUSED}
      />
    </>
  );
}
