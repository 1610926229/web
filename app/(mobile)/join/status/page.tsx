import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import CompanionApplicationProgress from "@/components/companions/CompanionApplicationProgress";
import RequireAuth from "@/lib/auth/RequireAuth";
import { COMPANION_JOIN_STATUS_PAGE_TITLE } from "@/lib/constants/companionApplications";
import { getMyCompanionApplicationDetail } from "@/lib/services/companionApplications";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 入驻进度（**仅本人可见**，需登录）。
 *
 * 提交成功后表单会用 `router.replace("/join/status")` 落到这里，
 * 因此浏览器后退不会回到那张已经提交过的表单。刷新页面同样能看到最新状态——
 * 数据每次都从服务端读，页面不做任何本地的状态镜像。
 *
 * 页面拿到的只有**属于当前用户**的申请：`getMyCompanionApplicationDetail` 以会话里的
 * `userId` 作为查询条件，没有「查谁的申请」这种参数，因此也拿不到别人的。
 *
 * 「还没有申请」是**正常状态**，不是错误、也不用 404：显示空态并给出回到 `/join` 的入口。
 * 直接给 404 会让「我还没申请过」看起来像「链接坏了」。
 *
 * 页面**没有任何审核入口**：没有「模拟通过 / 模拟拒绝」，也没有重新申请按钮——
 * 审核规则与重新申请规则都尚未确认。
 */
export default async function JoinStatusPage({ searchParams }: PageProps<"/join/status">) {
  const query = toSearchParams(await searchParams);

  return (
    <>
      <NavBar title={COMPANION_JOIN_STATUS_PAGE_TITLE} showBack />

      <RequireAuth>
        {(user) => <JoinStatusBody userId={user.id} query={query} />}
      </RequireAuth>
    </>
  );
}

async function JoinStatusBody({ userId, query }: { userId: string; query: URLSearchParams }) {
  const application = await getMyCompanionApplicationDetail(userId, query, "server");
  if (!application) return <NoApplication />;

  return <CompanionApplicationProgress application={application} />;
}

/** 还没有申请过。这里不是错误页，只是一条「还没开始」的正常状态。 */
function NoApplication() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
      <EmptyState
        title="还没有入驻申请"
        description="提交入驻申请后，这里会显示审核进度与审核结果。"
      />
      <Link
        href="/join"
        className="flex h-11 items-center justify-center rounded-full bg-brand-blue px-8 text-[15px] font-medium text-white"
      >
        去填写入驻申请
      </Link>
    </div>
  );
}
