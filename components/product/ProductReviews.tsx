import ReviewAggregatePanel from "@/components/reviews/ReviewAggregatePanel";
import type { ReviewAggregate } from "@/lib/types/review";

/**
 * 商品详情的「用户评价」区块（P1-8）。
 *
 * 内容全部交给 `ReviewAggregatePanel`——商品页与打手页的评分展示规则必须一致（`R3`），
 * 本组件只负责商品详情页那层白色分区外壳。若在这里再写一遍平均分 / 空态 / 截断提示，
 * 打手页就会慢慢长成另一套口径（最典型的是「没有评价时显示 0.0」）。
 *
 * `reviews` 是 `ProductDetailView` 上的**必填**字段：聚合由服务层贴上，
 * 页面忘记渲染时是缺一块，而不是悄悄少一个数字。
 */
export default function ProductReviews({ reviews }: { reviews: ReviewAggregate }) {
  return (
    <section className="mt-2 bg-surface px-4 py-4">
      <h2 className="text-[15px] font-medium text-ink">用户评价</h2>
      <div className="mt-2">
        <ReviewAggregatePanel aggregate={reviews} emptyText="这件商品还没有公开评价。" />
      </div>
    </section>
  );
}
