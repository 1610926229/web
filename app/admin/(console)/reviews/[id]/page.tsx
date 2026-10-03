import { notFound } from "next/navigation";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminReviewConsole from "@/components/admin/AdminReviewConsole";
import AdminReviewSections from "@/components/admin/AdminReviewSections";
import { ADMIN_REVIEWS_DETAIL_TITLE, ADMIN_REVIEWS_PAGE_TITLE } from "@/lib/constants/admin";
import { getAdminReviewDetail } from "@/lib/services/adminReviews";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 评价审核详情（`/admin/reviews/[id]`）。
 *
 * ## 为什么四个动作只放在这一页
 *
 * 列表里没有「通过」按钮：审核要判断的是「这条内容该不该公开」，而这件事**必须**
 * 看完整正文、两个维度与凭证。让人在列表行上闭着眼睛点通过，等于把一条会立刻出现在
 * 商品页与打手页上的内容交给他没看过的信息去决定。
 *
 * ## 只读 / 可写分两块
 *
 * `AdminReviewSections` 是只读的案件内容（含审核历史），`AdminReviewConsole` 是唯一的写入口。
 * 两者不共用状态：只读那块直接渲服务端取好的 `review`，写那块维护自己的一份副本，
 * 动作成功后**就地更新**（响应里的 `status` / `statusLabel` 就是权威值），不整页重取。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 *
 * ⚠️ 取数只走 `lib/services/adminReviews.ts`（`surface: "server"`），页面不碰仓储。
 */
export default async function AdminReviewDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/reviews/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const review = await getAdminReviewDetail(id, query, "server");
  if (!review) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_REVIEWS_DETAIL_TITLE}
        backHref="/admin/reviews"
        backLabel={ADMIN_REVIEWS_PAGE_TITLE}
      />

      <AdminReviewSections review={review} />

      <AdminReviewConsole review={review} />
    </div>
  );
}
