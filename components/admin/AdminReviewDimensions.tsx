import {
  REVIEW_DIMENSION_EMPTY_LABEL,
  REVIEW_DIMENSION_LABELS,
  REVIEW_RATING_LABELS,
} from "@/lib/constants/reviews";
import type { ReviewDimension } from "@/lib/types/review";

/**
 * 管理端的**双维度**内容展示（列表行与详情页共用）。
 *
 * ⚠️ **两个维度都要给**（`D2`）：管理员必须同时看到商品侧与打手侧才能判断
 * 「这条到底该不该公开」。只给一个维度，他就会在看不见用户实际写的另一半的情况下做决定。
 *
 * 与用户端同一处细节：某一维度为 `null` 时显示「未评价」，**不画灰星**——
 * 五颗灰星看起来像「打了 0 星」，而这个取值根本不存在（`ReviewRating` 是 1–5）。
 */
export default function AdminReviewDimensions({
  productReview,
  companionReview,
  /** 列表行里的紧凑版：正文截断到若干行，详情页给全量 */
  compact = false,
}: {
  productReview: ReviewDimension | null;
  companionReview: ReviewDimension | null;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Dimension dimension={productReview} label={REVIEW_DIMENSION_LABELS.product} compact={compact} />
      <Dimension
        dimension={companionReview}
        label={REVIEW_DIMENSION_LABELS.companion}
        compact={compact}
      />
    </div>
  );
}

function Dimension({
  label,
  dimension,
  compact,
}: {
  label: string;
  dimension: ReviewDimension | null;
  compact: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-8 shrink-0 pt-px text-[12px] text-ink-3">{label}</span>
      <div className="min-w-0 flex-1">
        {dimension ? (
          <>
            <Stars rating={dimension.rating} />
            {dimension.content ? (
              <p
                className={`mt-0.5 break-words text-[12px] leading-4 text-ink-2 ${
                  compact ? "line-clamp-2" : "whitespace-pre-wrap"
                }`}
              >
                {dimension.content}
              </p>
            ) : null}
          </>
        ) : (
          <span className="text-[12px] text-ink-3">{REVIEW_DIMENSION_EMPTY_LABEL}</span>
        )}
      </div>
    </div>
  );
}

/** 星级：星星是图形，读屏用户靠 `aria-label` 知道几星。 */
function Stars({ rating }: { rating: ReviewDimension["rating"] }) {
  return (
    <span
      role="img"
      aria-label={REVIEW_RATING_LABELS[rating]}
      className="text-[12px] leading-4 tracking-[1px] text-brand-yellow"
    >
      {"★".repeat(rating)}
      <span className="text-line" aria-hidden>
        {"★".repeat(5 - rating)}
      </span>
    </span>
  );
}
