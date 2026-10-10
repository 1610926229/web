/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { DetailRow, Section } from "@/components/admin/AdminDetailSection";
import AdminReviewDimensions from "@/components/admin/AdminReviewDimensions";
import AdminReviewStatusBadge from "@/components/admin/AdminReviewStatusBadge";
import { companionLabel } from "@/lib/constants/reviews";
import type { AdminReviewDetail } from "@/lib/types/review";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 评价详情的**只读**部分：关联订单 / 作者 / 评价内容 / 凭证 / 审核信息。
 *
 * ⚠️ **本文件只读**：没有任何输入框、按钮或写接口调用。唯一的写入口是
 * `AdminReviewConsole`，它由页面放在本组件下面。
 *
 * ⚠️ **两个维度都在**（`D2`）：管理员要同时看到商品侧与打手侧才能判断
 * 「这条到底该不该公开」。只给一个维度会让他在看不见另一半的情况下做决定。
 *
 * ⚠️ `user` 是管理侧的 `AdminUserSummary`（与订单 / 退款 / 投诉同一套），
 * 不是公开面的脱敏昵称——审核必须能回答「这是谁写的」（`D13` 管的是公开面）。
 *
 * ⚠️ **服务端组件**：内容全部来自已经取好的 `AdminReviewDetail`，本身不取数。
 */
export default function AdminReviewSections({ review }: { review: AdminReviewDetail }) {
  return (
    <>
      <Section title="评价状态">
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">当前状态</span>
          <span className="min-w-0 flex-1">
            <AdminReviewStatusBadge status={review.status} label={review.statusLabel} />
          </span>
        </div>
        <DetailRow label="评价编号" value={review.id} />
        <DetailRow label="订单号" value={review.orderNo} />
        <DetailRow label="提交时间" value={formatDateTime(review.createdAt)} />
        <DetailRow label="更新时间" value={formatDateTime(review.updatedAt)} />
        {/* 原因与状态对应显示：驳回原因是给作者改的，隐藏原因是平台撤下的说明（D8） */}
        {review.status === "rejected" ? (
          <DetailRow label="驳回原因" value={review.rejectReason ?? ""} />
        ) : null}
        {review.status === "hidden" ? (
          <DetailRow label="隐藏原因" value={review.hideReason ?? ""} />
        ) : null}
      </Section>

      <Section title="关联订单">
        <div className="flex gap-3">
          <img
            src={review.productCoverUrl}
            alt=""
            className="h-16 w-16 shrink-0 rounded-lg border border-admin-line object-cover"
          />
          <div className="min-w-0 flex-1">
            <DetailRow label="商品" value={review.productTitle} />
            <DetailRow label="规格" value={`${review.specName} · ×${review.quantity}`} />
          </div>
        </div>
        {/* 打手是**实际履约的那一位**（D4）；没绑定时显示「未绑定」，不编一个名字 */}
        <DetailRow label="打手" value={companionLabel(review.companion)} />
        <DetailRow label="完成时间" value={formatDateTime(review.completedAt)} />
      </Section>

      <Section title="作者">
        <DetailRow label="昵称" value={review.user.nickname} />
        <DetailRow label="展示号" value={review.user.displayId} />
      </Section>

      <Section title="评价内容">
        <AdminReviewDimensions
          productReview={review.productReview}
          companionReview={review.companionReview}
        />
        <p className="mt-2 text-[12px] leading-4 text-ink-3">
          {`未评价的维度显示「未评价」，不代表 0 星。`}
        </p>
      </Section>

      <Section title="凭证">
        {review.evidence.length === 0 ? (
          <p className="text-[13px] text-ink-3">用户没有上传凭证。</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {review.evidence.map((item) => (
              <li key={item.id} className="w-24">
                <img
                  src={item.url}
                  alt=""
                  className="aspect-square w-full rounded-lg border border-admin-line object-cover"
                />
                <span className="mt-1 block truncate text-[11px] text-ink-3">{item.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="审核信息">
        {/* 从未被审核过时如实说「尚未审核」，不显示一个空名字 */}
        <DetailRow
          label="最近审核"
          value={review.reviewedAt ? formatDateTime(review.reviewedAt) : "尚未审核"}
        />
        <DetailRow label="审核人" value={review.reviewedByName ?? ""} />
      </Section>
    </>
  );
}
