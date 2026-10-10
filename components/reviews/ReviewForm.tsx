"use client";

/* eslint-disable @next/next/no-img-element -- 商品封面为 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type RefObject } from "react";
import EvidencePicker from "@/components/common/EvidencePicker";
import { ApiError } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import {
  REVIEW_COMPANION_UNBOUND_LABEL,
  REVIEW_CONTENT_MAX_LENGTH,
  REVIEW_DIMENSION_HEADINGS,
  REVIEW_DIMENSION_MISSING_MESSAGE,
  REVIEW_EVIDENCE_KINDS,
  REVIEW_EVIDENCE_MAX_COUNT,
  REVIEW_MOCK_NOTICE,
  REVIEW_RATINGS,
  REVIEW_RATING_LABELS,
  REVIEW_RATING_REQUIRED_MESSAGE,
  REVIEW_STATUS_LABELS,
  companionLabel,
  isReviewRating,
  normalizeReviewContent,
  reviewDimensionErrors,
  reviewRatingLabel,
} from "@/lib/constants/reviews";
import { resubmitReview, submitReview } from "@/lib/services/reviewsHttp";
import type { ReviewDimension, ReviewListItem, ReviewPendingItem } from "@/lib/types/review";
import { formatDateTime } from "@/lib/utils/format";
import { countCharacters } from "@/lib/utils/text";

/**
 * 发表 / 重新提交评价表单（P1-8 双维度）。
 *
 * ## 两个维度是**两件独立的事**（`D1` / `D2` / `D3`）
 *
 * 商品与打手各占一个评价块，星级与正文**互不复制**：给商品打了 5 星，
 * 不表示这一单的打手也是 5 星；把两处绑在同一个 state 上就等于替用户回答了
 * 「这位打手怎么样」。用户也可以只评其中一个——没评的那个维度提交时是 `null`，
 * 不需要另一个状态位去表达（`D3`）。
 *
 * 「星级必填、正文可选」是按**维度**说的，不是按表单：一个维度只要存在就一定有星，
 * 但可以没有文字。因此「只写了字没给星」是错误（那个维度没有存在标志），
 * 而「一个字都没写也没给星」只是「没评这一项」，不是漏填。
 *
 * ## 两种模式
 *
 * - `create`：一笔**还没评价过**的订单，调 `submitReview(orderId, …)`；
 * - `resubmit`：一条**被驳回**的评价，用原内容预填，调 `resubmitReview(review.id, …)`
 *   （落点是评价本身，`rejected → pending`，不是新建）。
 *
 * 重提**不传幂等键**，这是刻意的：它的守卫是状态本身——`rejected` 是唯一入口，
 * 第一次成功后入口就关上了（详见 `reviewsHttp.ts` 的 `resubmitReview`）。
 * 新建则沿用其它表单的同一套做法：一次「提交意图」一个键，失败重试复用。
 *
 * ## 提交前本地再判一次
 *
 * 与服务端同一套规则（至少一个维度、星级必填、正文长度），不合格就一个字节都不发出去。
 * 界面只是提前拦，真正的判定仍在服务端。
 */

export type ReviewFormProps =
  | { mode: "create"; order: ReviewPendingItem }
  | { mode: "resubmit"; review: ReviewListItem };

/** 一个维度的提交值。`null` 表示这一项没评。 */
type DimensionDraft = { ok: true; value: ReviewDimension | null } | { ok: false; message: string };

/**
 * 从「星级 + 正文」拼出一个维度。
 *
 * ⚠️ 只有**写了字却没给星**才失败：那是「一个没有存在标志的维度」（`D3`），
 * 服务端也会拒。一个字都没写的空维度不是错误，它就是「没评这一项」。
 */
function buildDimension(rating: number, content: string): DimensionDraft {
  if (!isReviewRating(rating)) {
    return content.trim() ? { ok: false, message: REVIEW_RATING_REQUIRED_MESSAGE } : { ok: true, value: null };
  }

  const parsed = normalizeReviewContent(content);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, value: { rating, content: parsed.content } };
}

export default function ReviewForm(props: ReviewFormProps) {
  const router = useRouter();

  // 两种模式的订单/商品摘要字段完全同形，取一份给下面的「关联订单」区块用
  const source = props.mode === "create" ? props.order : props.review;
  const unboundCompanion = source.companion === null;
  /** 打手块不可评时，它的 state 不参与提交（`companion === null` 的订单没有打手可评） */
  const companionUnbound = unboundCompanion;

  const initialProduct = props.mode === "resubmit" ? props.review.productReview : null;
  const initialCompanion = props.mode === "resubmit" ? props.review.companionReview : null;

  const [productRating, setProductRating] = useState(initialProduct?.rating ?? 0);
  const [productContent, setProductContent] = useState(initialProduct?.content ?? "");
  const [companionRating, setCompanionRating] = useState(initialCompanion?.rating ?? 0);
  const [companionContent, setCompanionContent] = useState(initialCompanion?.content ?? "");
  // 凭证以「类型 + 文件名」的形式重填：服务端给的 url 是它自己写的占位图，不回传
  const [evidence, setEvidence] = useState<EvidenceDraft[]>(
    props.mode === "resubmit"
      ? props.review.evidence.map((item) => ({ kind: item.kind, name: item.name }))
      : [],
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const productRatingRef = useRef<HTMLDivElement>(null);
  const companionRatingRef = useRef<HTMLDivElement>(null);

  /** 单飞闸门：成功后不复位——那时正在跳转，复位反而会给出二次提交的机会。 */
  const submittingRef = useRef(false);
  /**
   * 幂等键：一次「提交意图」一个键。内容被改动时清空——改了内容就是另一次意图，
   * 沿用旧键会让服务端返回上一次的结果，用户会看到「提交成功但内容还是旧的」。
   * 提交失败则保留同一个键，于是重试不会产生第二条评价。（重提模式不需要它。）
   */
  const submitKeyRef = useRef<string | null>(null);

  function invalidateSubmitKey() {
    submitKeyRef.current = null;
  }

  // 超长是即时可见的客观事实，与是否点过提交无关；「请选择评分」只在该维度已经写了字时出现
  const productErrors = reviewDimensionErrors({
    rating: productRating,
    content: productContent,
    attempted: productContent.trim() !== "",
  });
  const companionErrors = reviewDimensionErrors({
    rating: companionRating,
    content: companionContent,
    attempted: companionContent.trim() !== "",
  });

  const hasAnyRating = isReviewRating(productRating) || (!unboundCompanion && isReviewRating(companionRating));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    setFormError(null);

    const product = buildDimension(productRating, productContent);
    if (!product.ok) {
      setFormError(product.message);
      productRatingRef.current?.querySelector("button")?.focus();
      return;
    }

    const companion = buildDimension(unboundCompanion ? 0 : companionRating, companionContent);
    if (!companion.ok) {
      setFormError(companion.message);
      companionRatingRef.current?.querySelector("button")?.focus();
      return;
    }

    // 至少评一项（`D3`）：两项都没评时按钮本来就不可用，这里再兜一次
    if (!product.value && !companion.value) {
      setFormError(REVIEW_DIMENSION_MISSING_MESSAGE);
      return;
    }

    submittingRef.current = true;
    setPending(true);

    try {
      if (props.mode === "create") {
        submitKeyRef.current ??= crypto.randomUUID();
        await submitReview(props.order.orderId, {
          productReview: product.value,
          companionReview: companion.value,
          evidence,
          idempotencyKey: submitKeyRef.current,
        });
      } else {
        await resubmitReview(props.review.id, {
          productReview: product.value,
          companionReview: companion.value,
          evidence,
        });
      }
      // 用 replace：提交完再回退不该回到一张已经提交过的表单
      router.replace("/reviews");
      router.refresh();
    } catch (cause) {
      // 失败时两个维度、凭证全部保留，用户改一下就能重试
      setFormError(cause instanceof ApiError ? cause.message : "提交失败，请稍后重试");
      submittingRef.current = false;
      setPending(false);
    }
  };

  const isResubmit = props.mode === "resubmit";

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col bg-page pb-8" noValidate>
      {/* 被驳回的评价：先把「为什么退回」说清楚，用户才知道该改哪里（`D10` 的闭环） */}
      {isResubmit ? (
        <section className="bg-surface px-4 py-3">
          <h2 className="text-[14px] font-medium text-status-danger">
            {`本条评价${REVIEW_STATUS_LABELS.rejected}`}
          </h2>
          {/* 原因必填（D10），因此这里一定有一句可显示的话；真的缺时不编一句，如实留白 */}
          <p className="mt-1 break-words text-[13px] leading-5 text-ink-2">
            驳回原因：{props.review.rejectReason ?? "未填写"}
          </p>
          <p className="mt-1 text-[12px] leading-4 text-ink-3">
            修改后重新提交即可，本单不会产生第二条评价。
          </p>
        </section>
      ) : null}

      {/* 关联订单：让用户在写评价前再确认一次评的是哪一单 */}
      <section className={`bg-surface px-4 py-3 ${isResubmit ? "mt-2" : ""}`}>
        <h2 className="text-[14px] font-medium text-ink">评价订单</h2>
        <div className="mt-2 flex gap-3">
          <img
            src={source.productCoverUrl}
            alt={source.productTitle}
            className="h-16 w-16 shrink-0 rounded-[8px] border border-line object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
              {source.productTitle}
            </p>
            <p className="mt-1 break-words text-[12px] leading-4 text-ink-3">
              {source.specName} · ×{source.quantity}
            </p>
            <p className="mt-auto break-words pt-1 text-[12px] leading-4 text-ink-3">
              订单号 {source.orderNo}
            </p>
          </div>
        </div>
        <p className="mt-2 border-t border-line pt-2 text-[12px] leading-4 text-ink-3">
          打手 {companionLabel(source.companion)} · 完成于 {formatDateTime(source.completedAt)}
        </p>
      </section>

      {/* 商品维度：星级必填、正文可选；与打手块完全独立 */}
      <DimensionBlock
        heading={REVIEW_DIMENSION_HEADINGS.product}
        rating={productRating}
        content={productContent}
        ratingRef={productRatingRef}
        ratingError={productErrors.rating}
        contentError={productErrors.content}
        disabled={pending}
        onRating={(value) => {
          invalidateSubmitKey();
          setProductRating(value);
          setFormError(null);
        }}
        onContent={(value) => {
          invalidateSubmitKey();
          setProductContent(value);
        }}
      />

      {/* 打手维度：这一单没有实际履约打手时不可评（D4），如实说明而不是留白 */}
      <DimensionBlock
        heading={REVIEW_DIMENSION_HEADINGS.companion}
        rating={companionRating}
        content={companionContent}
        ratingRef={companionRatingRef}
        ratingError={companionErrors.rating}
        contentError={companionErrors.content}
        disabled={pending}
        unbound={companionUnbound}
        onRating={(value) => {
          invalidateSubmitKey();
          setCompanionRating(value);
          setFormError(null);
        }}
        onContent={(value) => {
          invalidateSubmitKey();
          setCompanionContent(value);
        }}
      />

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

        {/*
          两项都没评时按钮禁用，**但旁边必须有话说**：一个点不动的按钮本身不解释原因。
          它说的正是「商品或打手都行」，否则用户会以为两项都得填。
        */}
        {!hasAnyRating ? (
          <p className="mt-2 text-[12px] leading-4 text-ink-3">{REVIEW_DIMENSION_MISSING_MESSAGE}</p>
        ) : null}

        {formError ? (
          <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
            {formError}
          </p>
        ) : null}

        {/*
          按钮随表单在文档流内，不用 fixed/sticky，因此不会遮挡上面的输入项。
          超长时**不禁用**它：禁用之后点击不再触发任何反馈，用户只会觉得「按钮坏了」。
          保持可点，由 handleSubmit 拦住请求并把光标送到出错的字段；
          只有「一项都没评」这一种情况禁用（没有任何可提交的内容）。
        */}
        <button
          type="submit"
          disabled={pending || !hasAnyRating}
          className="mt-3 h-11 w-full rounded-full bg-brand-red text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "提交中…" : isResubmit ? "重新提交" : "提交评价"}
        </button>
      </div>
    </form>
  );
}

/**
 * 一个评价块（商品 / 打手共用同一个形状）。
 *
 * 两块之间**不共享任何 state**：`rating` / `content` 都由调用方各自传入。
 * 把它们合并成「一份评价 + 一个对象选择器」会让「两个维度各自有几星」这件事
 * 在数据上消失，而它恰恰是 `D2` 的全部要求。
 */
function DimensionBlock({
  heading,
  rating,
  content,
  ratingRef,
  ratingError,
  contentError,
  disabled,
  unbound = false,
  onRating,
  onContent,
}: {
  heading: string;
  rating: number;
  content: string;
  ratingRef: RefObject<HTMLDivElement | null>;
  ratingError: string | null;
  contentError: string | null;
  disabled: boolean;
  /** 这一单没有实际履约打手：整块不可评，只说明原因 */
  unbound?: boolean;
  onRating: (value: number) => void;
  onContent: (value: string) => void;
}) {
  const contentCount = countCharacters(content);
  const contentTooLong = contentCount > REVIEW_CONTENT_MAX_LENGTH;
  const contentId = `${heading}-content`;

  if (unbound) {
    return (
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">{heading}</h2>
        <p className="mt-2 text-[13px] text-ink-3">{REVIEW_COMPANION_UNBOUND_LABEL}</p>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          这一单没有实际履约的打手，无法评价打手。
        </p>
      </section>
    );
  }

  return (
    <section className="mt-2 bg-surface px-4 py-3">
      <h2 className="text-[14px] font-medium text-ink">
        {heading} <span className="text-brand-red">*</span>
      </h2>

      <div
        ref={ratingRef}
        role="group"
        aria-label={heading}
        aria-describedby={ratingError ? `${contentId}-rating-error` : undefined}
        className="mt-2 flex items-center gap-2"
      >
        {REVIEW_RATINGS.map((value) => {
          const active = value <= rating;
          return (
            <button
              key={value}
              type="button"
              disabled={disabled}
              aria-pressed={rating === value}
              aria-label={REVIEW_RATING_LABELS[value]}
              onClick={() => onRating(value)}
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
        <p
          id={`${contentId}-rating-error`}
          role="alert"
          className="mt-1 text-[12px] leading-5 text-brand-red"
        >
          {ratingError}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[13px] text-ink-2">评价内容（选填）</span>
        {/* 字数实时可见：超限后计数自己变红，不需要用户猜「为什么打不进去」 */}
        <span className={`text-[12px] ${contentTooLong ? "text-brand-red" : "text-ink-3"}`}>
          {contentCount}/{REVIEW_CONTENT_MAX_LENGTH}
        </span>
      </div>
      <textarea
        value={content}
        disabled={disabled}
        onChange={(event) => onContent(event.target.value)}
        rows={3}
        placeholder="说说这次服务体验，可以帮到其他用户"
        aria-label={`${heading}内容`}
        aria-invalid={contentError !== null}
        aria-describedby={contentError ? `${contentId}-error` : undefined}
        className={`mt-1 w-full resize-none rounded-[8px] border px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 ${
          contentError ? "border-brand-red" : "border-line focus:border-brand-blue-border"
        }`}
      />
      {contentError ? (
        <p id={`${contentId}-error`} role="alert" className="mt-1 text-[12px] leading-5 text-brand-red">
          {contentError}
        </p>
      ) : null}
    </section>
  );
}
