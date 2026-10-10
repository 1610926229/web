import {
  REVIEW_RATING_LABELS,
  REVIEW_TRUNCATED_NOTICE,
  formatAverageRating,
} from "@/lib/constants/reviews";
import type { ReviewAggregate, ReviewRating } from "@/lib/types/review";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 公开评分聚合（P1-8）——**商品详情与打手详情共用的那一块**。
 *
 * 抽成一个组件的理由只有一个（`R3`）：两侧的评分展示规则必须完全一致。
 * 各写一份时最典型的漂移是「一边没有公开评价时显示 0.0、另一边显示暂无评分」，
 * 而两种写法都能「看起来正常」——用户看到 0 分会以为这件商品被差评到 0，
 * 实际上只是还没有人评过。平均分、空态、截断提示三处因此都只在这里渲染一次。
 *
 * ⚠️ `reviewCount` 是**评价维度数**，不是评价条数（`D15`）：一条只评了商品的评价
 * 对商品侧 +1、对打手侧 +0。所以这里写「N 项评分」而不是「N 条评价」——
 * 后者会让人以为平台收了 N 条订单评价，实际数量可能完全不同。
 *
 * 这是一个**服务端组件**：数据由页面取好传进来，它不做任何取数、不发请求。
 */
export default function ReviewAggregatePanel({
  aggregate,
  emptyText = "暂无公开评价。",
}: {
  aggregate: ReviewAggregate;
  /** 一条评价都没有时的说法。两侧可以在同一套规则下各说各的**对象**（商品 / 陪玩）。 */
  emptyText?: string;
}) {
  const { averageRating, reviewCount, reviews, reviewsTruncated } = aggregate;

  return (
    <div>
      {/* 评分摘要：平均分走 `formatAverageRating`，没有评价时说「暂无评分」而不是 0 分 */}
      <div className="flex items-baseline gap-2">
        <span className="text-[18px] font-semibold text-ink">
          {formatAverageRating(averageRating)}
        </span>
        {averageRating === null ? null : (
          <span className="text-brand-yellow" aria-hidden>
            ★
          </span>
        )}
        {/* 计数是**维度数**，因此不写「条」——量词会把「项」读成「条订单评价」 */}
        {reviewCount > 0 ? (
          <span className="text-[12px] text-ink-3">共 {reviewCount} 项评分</span>
        ) : null}
      </div>

      {reviews.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-3">{emptyText}</p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col gap-3">
            {reviews.map((review) => (
              <li
                key={review.id}
                className="border-b border-line pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[13px] text-ink-2">
                    {review.nickname}
                  </span>
                  <ReviewStars rating={review.rating} />
                  <span className="ml-auto shrink-0 text-[11px] text-ink-3">
                    {formatDateTime(review.createdAt)}
                  </span>
                </div>
                {/* 正文可选：只打了星没写字时就只显示星，不留一行空白 */}
                {review.content ? (
                  <p className="mt-1 break-words text-[13px] leading-5 text-ink-2">
                    {review.content}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {/* 只显示最近 N 条却不说，会让人以为这件商品总共就这么几条评价（D15 / D16） */}
          {reviewsTruncated ? (
            <p className="mt-2 text-[12px] text-ink-3">{REVIEW_TRUNCATED_NOTICE}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 星级：星星是图形，读屏用户靠 `aria-label` 知道几星。 */
function ReviewStars({ rating }: { rating: ReviewRating }) {
  return (
    <span
      role="img"
      aria-label={REVIEW_RATING_LABELS[rating]}
      className="shrink-0 text-[12px] leading-5 tracking-[1px] text-brand-yellow"
    >
      {"★".repeat(rating)}
      <span className="text-line" aria-hidden>
        {"★".repeat(5 - rating)}
      </span>
    </span>
  );
}
