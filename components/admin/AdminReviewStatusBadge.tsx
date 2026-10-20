import AdminStatusBadge, { type AdminStatusTone } from "@/components/admin/AdminStatusBadge";
import { REVIEW_STATUS_TONES } from "@/lib/constants/reviews";
import type { ReviewStatus } from "@/lib/types/review";

/**
 * 评价状态 → 管理端语气。
 *
 * 分类取自 `lib/constants/reviews.ts` 的 `REVIEW_STATUS_TONES`
 * （`neutral` / `positive` / `negative`），这里只把它翻译成 `AdminStatusBadge`
 * 的四种语气——**不在组件里重新判断哪个状态算红**（那等于把语义抄第二遍）。
 *
 * ⚠️ 「已被管理员隐藏」与「已驳回」同为 `negative`：两者都需要被看见。
 * 「审核中」用 `pending`（橙）而不是灰：它是一件**等着人处理**的事，
 * 不是「已经结束、不必再看」的终态。
 */
const TONE_BY_KIND: Record<
  (typeof REVIEW_STATUS_TONES)[ReviewStatus],
  AdminStatusTone
> = {
  neutral: "pending",
  positive: "success",
  negative: "danger",
};

export function reviewStatusTone(status: ReviewStatus): AdminStatusTone {
  return TONE_BY_KIND[REVIEW_STATUS_TONES[status]];
}

/**
 * 评价状态标注。`label` 一律传服务端给的 `statusLabel`——
 * 页面不自己拼「审核中 / 已通过」，否则同一句话会在前后台出现两个版本。
 */
export default function AdminReviewStatusBadge({
  status,
  label,
}: {
  status: ReviewStatus;
  label: string;
}) {
  return <AdminStatusBadge label={label} tone={reviewStatusTone(status)} />;
}
