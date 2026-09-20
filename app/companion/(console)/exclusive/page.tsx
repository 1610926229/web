import CompanionDispatchTable from "@/components/companion/CompanionDispatchTable";
import { getSessionUser } from "@/lib/auth/session";
import {
  COMPANION_EXCLUSIVE_EMPTY,
  COMPANION_EXCLUSIVE_PAGE_TITLE,
} from "@/lib/constants/dispatch";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { listCompanionPools } from "@/lib/services/companionDispatch";

/**
 * 专属订单池（P0-5）：用户**指定给我**的单。
 *
 * 与公共池是同一份数据、同一个服务，只是取其中一半：服务端返回的两张池子
 * 都已经按当前打手收窄过（专属池只包含 `exclusiveCompanionId` 是他的单），
 * 因此这一页做的只是「显示哪一半」。
 *
 * ## 这一页**没有**「不接」按钮，也不该有
 *
 * 打手不想接的时候什么都不用做：专属池的单在他手里留 10 分钟，到点系统自动
 * 转入公共池。加一个「拒绝」按钮就等于承认存在一条「主动退回」的写入路径，
 * 而需求里没有这条路径——不接本身就是拒绝。
 *
 * ⚠️ 与公共池页同样，这一页自己读资格（布局无法给 `children` 传 props），
 * 但读取是**请求内共享的**（`React.cache`），因此不会多读一次仓储。
 *
 * ⚠️ **暂停接单（`available = false`）不改变这一页的内容**：这些单是「用户当初
 * 指定了我」这条历史事实，我现在接不了新单不代表它没发生过。他照样看得到、
 * 照样知道还剩多久转公共池——只是卡片上没有接单按钮（`pools.canAccept`），
 * 以及顶部换成暂停的那句说明（`pools.notice`）。
 */
export default async function CompanionExclusivePage() {
  const user = await getSessionUser();
  if (!user) return null;

  const access = await resolveCompanionAccess(user.id);
  if (access.kind !== "granted") return null;

  const pools = await listCompanionPools(access.companion.companionId, new Date().toISOString());

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold text-ink">{COMPANION_EXCLUSIVE_PAGE_TITLE}</h2>
        <p className="rounded-xl border border-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
          {pools.notice}
        </p>
      </div>

      <CompanionDispatchTable
        items={pools.exclusive}
        canAccept={pools.canAccept}
        emptyText={COMPANION_EXCLUSIVE_EMPTY}
      />
    </>
  );
}
