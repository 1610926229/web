"use client";

/* eslint-disable @next/next/no-img-element -- 陪玩头像为 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useState, type ReactNode } from "react";
import {
  COMPANION_DETAIL_DISABLED_NOTICE,
  COMPANION_DETAIL_DISABLED_TITLE,
  COMPANION_SELECTION_NOTICE,
} from "@/lib/constants/companions";
import type { CompanionDetail } from "@/lib/types/companion";
import { abbreviateNumber, formatDateTime } from "@/lib/utils/format";

/**
 * 陪玩详情（游客可见）。
 *
 * **本页没有任何下单能力，这是刻意的，不是「还没接上」。**
 * 陪玩与订单的最终绑定规则尚未确认，因此「选择这位陪玩」只能是一个本地演示：
 *
 * - 选择结果**只存在组件 state 里**，刷新即消失：不写 localStorage、不写 Cookie；
 * - 不发任何请求——没有创建订单、没有创建支付请求、没有写入陪玩关系；
 * - 不改动 P4 结算页的地址与参数，也不把陪玩 id 注入任何订单 / 支付 / 金额；
 * - 文案只说「绑定规则待确认」，**不使用「已预约 / 已锁定 / 已分配」**这类词，
 *   否则用户会以为真的约到了人。
 *
 * 不可选时的按钮**不只是一个灰块**：旁边写出具体原因（休息中 / 已排满），
 * 否则用户只会以为页面坏了。原因文案与列表卡片、结算页选择面板是同一句。
 *
 * 「不在公开名单里」（`listed: false`）与「在架但暂不可用」在这里是**两种页面**：
 * 前者只给已公开的资料，连选择区域都不出现；后者保留一个禁用按钮 + 具体原因。
 * 两者的 `available` 都是 `false`，因此只能用服务端给的 `listed` 区分：
 * 让前端拿 `available` 去猜哪一种，等于把一条业务规则复制到第二个地方。
 */
export default function CompanionDetailView({ companion }: { companion: CompanionDetail }) {
  // 演示用的选择状态：只活在这个组件里
  const [selected, setSelected] = useState(false);

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 头部：头像 + 昵称 + 可用状态 */}
      <div className="bg-surface px-4 py-4">
        <div className="flex gap-3">
          <img
            src={companion.avatarUrl}
            alt=""
            className="h-[72px] w-[72px] shrink-0 rounded-[12px] border border-line bg-page object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <h1 className="break-words text-[17px] font-medium leading-6 text-ink">
                {companion.displayName}
              </h1>
              <span
                className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4 ${
                  companion.available
                    ? "bg-brand-blue-soft text-status-success"
                    : "bg-page text-status-pending"
                }`}
              >
                {/* 符号 + 文字：状态不靠颜色单独表达 */}
                <span aria-hidden>{companion.available ? "●" : "○"}</span>
                {companion.available ? " 可接单" : " 暂不可用"}
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
              <span>
                <span className="text-brand-yellow" aria-hidden>
                  ★
                </span>{" "}
                {/* 没有评价时显示「暂无评分」，不用 0 分冒充 */}
                {companion.rating === null ? "暂无评分" : companion.rating.toFixed(1)}
                <span className="ml-1 text-ink-3">({companion.reviewCount} 条评价)</span>
              </span>
              <span className="text-ink-3">
                {abbreviateNumber(companion.completedOrderCount)} 单
              </span>
              <span className="text-ink-3">鸡腿 {abbreviateNumber(companion.tipsCount)}</span>
            </div>
          </div>
        </div>

        {!companion.available ? (
          <div className="mt-3 rounded-[8px] bg-page px-3 py-2">
            <p className="text-[13px] font-medium text-ink-2">{COMPANION_DETAIL_DISABLED_TITLE}</p>
            {companion.unavailableReason ? (
              <p className="mt-0.5 text-[12px] leading-4 text-ink-3">
                {companion.unavailableReason}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 自我介绍 */}
      <Section title="自我介绍">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-2">
          {companion.intro}
        </p>
      </Section>

      {/* 擅长游戏与服务标签 */}
      <Section title="擅长游戏与服务">
        <ul className="flex flex-wrap gap-1.5">
          {companion.games.map((game) => (
            <li
              key={game.id}
              className="rounded-[6px] bg-page px-2 py-0.5 text-[11px] leading-5 text-ink-2"
            >
              {game.name}
            </li>
          ))}
          {companion.serviceTags.map((tag) => (
            <li
              key={tag}
              className="rounded-[6px] border border-line px-2 py-0.5 text-[11px] leading-5 text-ink-3"
            >
              {tag}
            </li>
          ))}
        </ul>
      </Section>

      {/* 服务大区 */}
      {companion.regions.length > 0 ? (
        <Section title="可服务大区">
          <ul className="flex flex-wrap gap-1.5">
            {companion.regions.map((region) => (
              <li
                key={region}
                className="rounded-[6px] bg-page px-2 py-0.5 text-[11px] leading-5 text-ink-2"
              >
                {region}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* 评价摘要：只有公开的昵称 / 星级 / 正文 / 时间 */}
      <Section title={`评价${companion.reviewCount > 0 ? `（${companion.reviewCount}）` : ""}`}>
        {companion.reviews.length === 0 ? (
          <p className="text-[13px] text-ink-3">这位陪玩还没有公开评价。</p>
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {companion.reviews.map((review) => (
                <li key={review.id} className="border-b border-line pb-3 last:border-b-0 last:pb-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-ink-2">{review.nickname}</span>
                    <span className="text-[12px] text-brand-yellow" aria-label={`${review.rating} 星`}>
                      {"★".repeat(review.rating)}
                      <span className="text-line" aria-hidden>
                        {"★".repeat(Math.max(0, 5 - review.rating))}
                      </span>
                    </span>
                    <span className="ml-auto text-[11px] text-ink-3">
                      {formatDateTime(review.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-[13px] leading-5 text-ink-2">
                    {review.content}
                  </p>
                </li>
              ))}
            </ul>
            {companion.reviewsTruncated ? (
              <p className="mt-2 text-[12px] text-ink-3">仅展示最近的部分评价。</p>
            ) : null}
          </>
        )}
      </Section>

      {/* ——————————————— 选择区域 ——————————————— */}
      <div className="mt-2 bg-surface px-4 py-4">
        {!companion.listed ? (
          // 已下架：这一页是只读资料页，**没有选择入口，也没有下单入口**。
          // 不给 404（这位陪玩确实存在过、链接也没错），但也不给一个选不动的按钮。
          <p className="text-[12px] leading-5 text-ink-3">{COMPANION_DETAIL_DISABLED_NOTICE}</p>
        ) : selected ? (
          // 选择后的结果面板：**只解释规则未定**，不给任何「已预约」的错觉
          <div
            role="status"
            className="rounded-[10px] border border-brand-blue-soft bg-brand-blue-soft px-3 py-3"
          >
            <p className="text-[13px] font-medium text-ink">
              已记录你的演示选择：{companion.displayName}
            </p>
            <p className="mt-1 text-[12px] leading-5 text-ink-2">{COMPANION_SELECTION_NOTICE}</p>
            <button
              type="button"
              onClick={() => setSelected(false)}
              className="mt-2.5 rounded-full border border-line bg-surface px-4 py-1.5 text-[12px] text-ink-2"
            >
              取消演示选择
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              disabled={!companion.selectable}
              aria-describedby={!companion.selectable ? "companion-unselectable-reason" : undefined}
              onClick={() => setSelected(true)}
              className="w-full rounded-full bg-brand-blue py-3 text-[15px] font-medium text-white disabled:bg-line disabled:text-ink-3"
            >
              选择这位陪玩（演示）
            </button>

            {!companion.selectable ? (
              // 在架但暂不可用（休息中 / 已排满）：按钮禁用，旁边必须有**具体原因**，
              // 不能只有一个灰按钮。（已下架的走上面那条分支，不出现按钮。）
              <p
                id="companion-unselectable-reason"
                role="note"
                className="mt-2 text-center text-[12px] leading-4 text-ink-3"
              >
                {`${COMPANION_DETAIL_DISABLED_TITLE}：${companion.unavailableReason || "暂不接单"}`}
              </p>
            ) : null}

            <p className="mt-2 text-[12px] leading-4 text-ink-3">{COMPANION_SELECTION_NOTICE}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** 详情页的白色分区块，保持与全站其它详情页一致的间距。 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2 bg-surface px-4 py-4">
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      <div className="mt-2">{children}</div>
    </div>
  );
}
