"use client";

/* eslint-disable @next/next/no-img-element -- 商品封面为 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import EvidencePicker from "@/components/common/EvidencePicker";
import { ApiError } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import {
  REVIEW_CONTENT_MAX_LENGTH,
  REVIEW_EVIDENCE_KINDS,
  REVIEW_EVIDENCE_MAX_COUNT,
  REVIEW_MOCK_NOTICE,
  REVIEW_RATINGS,
  REVIEW_RATING_LABELS,
  companionLabel,
  isReviewRating,
  normalizeReviewContent,
  reviewFieldErrors,
  reviewRatingLabel,
} from "@/lib/constants/reviews";
import { submitReview } from "@/lib/services/reviewsHttp";
import type { ReviewPendingItem } from "@/lib/types/review";
import { formatDateTime } from "@/lib/utils/format";
import { countCharacters } from "@/lib/utils/text";

/**
 * 发表评价表单（评分 / 正文 / Mock 图片凭证）。
 *
 * 三件事刻意不用 HTML 原生行为解决：
 *
 * 1. **字数不用 `maxLength` 静默截断**：可以一直输入，实时显示字符数（`countCharacters`，
 *    汉字 / 字母 / 普通 Emoji 都算 1 个），超限立刻变红并给出提示；提交时被拦住并
 *    把光标送到第一个出错的字段。静默截断的问题是「打不进去，却不知道为什么」。
 * 2. **防重复提交不只靠禁用按钮**：`submittingRef` 是同步闸门（`pending` 要等重渲染才生效，
 *    连点两下时第二次点击可能在重渲染之前到达）；同时一次「提交意图」一个幂等键，
 *    失败重试沿用同一个键——服务端因此只会产生一条评价。
 * 3. **成功后用 `router.replace` 回列表**：不往历史里留一张已提交的表单，
 *    浏览器后退不会回到这里再提交一次。
 *
 * 表单里没有身份字段：评分、正文、凭证之外的东西（用户、订单、打手、评价时间）
 * 全部由服务端决定，请求体里也没有它们的位置。
 */
export default function ReviewForm({ order }: { order: ReviewPendingItem }) {
  const router = useRouter();

  const [rating, setRating] = useState(0);
  const [content, setContent] = useState("");
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  /** 提交过一次之后才提示「请选择评分 / 请填写评价内容」：没点过就先不报错 */
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const ratingRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  /** 单飞闸门：成功后不复位——那时正在跳转，复位反而会给出二次提交的机会。 */
  const submittingRef = useRef(false);
  /**
   * 幂等键：一次「提交意图」一个键。内容被改动时清空——改了内容就是另一次意图，
   * 沿用旧键会让服务端返回上一次的结果，用户会看到「提交成功但内容还是旧的」。
   * 提交失败则保留同一个键，于是重试不会产生第二条评价。
   */
  const submitKeyRef = useRef<string | null>(null);

  function invalidateSubmitKey() {
    submitKeyRef.current = null;
  }

  const contentCount = countCharacters(content);
  const contentTooLong = contentCount > REVIEW_CONTENT_MAX_LENGTH;

  /**
   * 错误全部从当前输入**推导**出来（规则见 `reviewFieldErrors`），不额外存一份状态：
   * 超限是实时的，还没点提交就显示；「请选择评分 / 请填写」只在点过提交之后出现。
   */
  const { rating: ratingError, content: contentError } = reviewFieldErrors({
    rating,
    content,
    attempted,
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    setAttempted(true);
    setFormError(null);

    // 与服务端同一套规则：本地先判一次，不合格就一个字节都不发出去
    if (!isReviewRating(rating)) {
      ratingRef.current?.querySelector("button")?.focus();
      return;
    }
    const parsed = normalizeReviewContent(content);
    if (!parsed.ok) {
      contentRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setPending(true);

    submitKeyRef.current ??= crypto.randomUUID();

    try {
      await submitReview(order.orderId, {
        rating,
        content: parsed.content,
        evidence,
        idempotencyKey: submitKeyRef.current,
      });
      // 用 replace：提交完再回退不该回到一张已经提交过的表单
      router.replace("/reviews");
      router.refresh();
    } catch (cause) {
      // 失败时评分、正文、凭证全部保留，用户改一下就能重试
      setFormError(cause instanceof ApiError ? cause.message : "提交失败，请稍后重试");
      submittingRef.current = false;
      setPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col bg-page pb-8" noValidate>
      {/* 关联订单：让用户在写评价前再确认一次评的是哪一单 */}
      <section className="bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">评价订单</h2>
        <div className="mt-2 flex gap-3">
          <img
            src={order.productCoverUrl}
            alt={order.productTitle}
            className="h-16 w-16 shrink-0 rounded-[8px] border border-line object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
              {order.productTitle}
            </p>
            <p className="mt-1 break-words text-[12px] leading-4 text-ink-3">
              {order.specName} · ×{order.quantity}
            </p>
            <p className="mt-auto break-words pt-1 text-[12px] leading-4 text-ink-3">
              订单号 {order.orderNo}
            </p>
          </div>
        </div>
        <p className="mt-2 border-t border-line pt-2 text-[12px] leading-4 text-ink-3">
          打手 {companionLabel(order.companion)} · 完成于 {formatDateTime(order.completedAt)}
        </p>
      </section>

      {/* 评分：1–5 星，必选 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">
          评分 <span className="text-brand-red">*</span>
        </h2>
        <div
          ref={ratingRef}
          role="group"
          aria-label="评分"
          aria-describedby={ratingError ? "review-rating-error" : undefined}
          className="mt-2 flex items-center gap-2"
        >
          {REVIEW_RATINGS.map((value) => {
            const active = value <= rating;
            return (
              <button
                key={value}
                type="button"
                disabled={pending}
                aria-pressed={rating === value}
                aria-label={REVIEW_RATING_LABELS[value]}
                onClick={() => {
                  invalidateSubmitKey();
                  setRating(value);
                  setFormError(null);
                }}
                className={`text-[26px] leading-8 disabled:opacity-60 ${
                  active ? "text-brand-red" : "text-line"
                }`}
              >
                ★
              </button>
            );
          })}
          <span className="ml-1 text-[13px] text-ink-3">{reviewRatingLabel(rating)}</span>
        </div>
        {ratingError ? (
          <p id="review-rating-error" role="alert" className="mt-1 text-[12px] leading-5 text-brand-red">
            {ratingError}
          </p>
        ) : null}
      </section>

      {/* 评价内容：必填，长度受限但不静默截断 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-medium text-ink">
            评价内容 <span className="text-brand-red">*</span>
          </h2>
          {/* 字数实时可见：超限后计数自己变红，不需要用户猜「为什么打不进去」 */}
          <span className={`text-[12px] ${contentTooLong ? "text-brand-red" : "text-ink-3"}`}>
            {contentCount}/{REVIEW_CONTENT_MAX_LENGTH}
          </span>
        </div>
        <textarea
          ref={contentRef}
          value={content}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setContent(event.target.value);
          }}
          rows={4}
          placeholder="说说这次服务体验，可以帮到其他用户"
          aria-label="评价内容"
          aria-invalid={contentError !== null}
          aria-describedby={contentError ? "review-content-error" : undefined}
          className={`mt-2 w-full resize-none rounded-[8px] border px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 ${
            contentError ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {contentError ? (
          <p
            id="review-content-error"
            role="alert"
            className="mt-1 text-[12px] leading-5 text-brand-red"
          >
            {contentError}
          </p>
        ) : null}
      </section>

      {/* 凭证：只收图片，最多 4 张；与提交给服务端的上限、类型是同一份常量 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <EvidencePicker
          value={evidence}
          disabled={pending}
          maxCount={REVIEW_EVIDENCE_MAX_COUNT}
          kinds={REVIEW_EVIDENCE_KINDS}
          onChange={(next) => {
            invalidateSubmitKey();
            setEvidence(next);
          }}
        />
      </section>

      <div className="mt-2 px-4">
        <p className="text-[12px] leading-4 text-ink-3">{REVIEW_MOCK_NOTICE}</p>

        {formError ? (
          <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
            {formError}
          </p>
        ) : null}

        {/*
          按钮随表单在文档流内，不用 fixed/sticky，因此不会遮挡上面的输入项。
          超限时**不禁用**它：禁用之后点击不再触发任何反馈，用户只会觉得「按钮坏了」。
          保持可点，由 handleSubmit 拦住请求并把光标送到出错的字段。
        */}
        <button
          type="submit"
          disabled={pending}
          className="mt-3 h-11 w-full rounded-full bg-brand-red text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "提交中…" : "提交评价"}
        </button>
      </div>
    </form>
  );
}
