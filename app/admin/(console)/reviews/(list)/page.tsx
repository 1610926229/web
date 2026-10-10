import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminReviewTable from "@/components/admin/AdminReviewTable";
import { ADMIN_REVIEWS_PAGE_TITLE } from "@/lib/constants/admin";
import { queryAdminReviewList, resolveAdminReviewListQuery } from "@/lib/services/adminReviews";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 评价审核列表（`/admin/reviews`）。
 *
 * 取数与筛选全在服务层：页面只负责「解析地址栏参数 → 取一页 → 交给客户端组件」。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：状态取值写错时回退到默认
 * （待审核）而不是把整页变成错误页——与订单 / 退款列表同一套处理。
 *
 * ⚠️ 本页**只读**：四个审核动作在详情页——那里才看得到完整正文、两个维度与凭证。
 * 列表上放「通过」等于让人闭着眼睛批准一条会立刻出现在商品页与打手页上的内容。
 */
export default async function AdminReviewsPage({ searchParams }: PageProps<"/admin/reviews">) {
  const params = toSearchParams(await searchParams);
  const query = resolveAdminReviewListQuery(params, false);
  const data = await queryAdminReviewList(query, params, "server");

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_REVIEWS_PAGE_TITLE} description={data.notice} />

      <AdminReviewTable
        initialFilters={{ status: query.status, keyword: query.keyword, page: query.page }}
        initialResult={data}
      />
    </div>
  );
}
