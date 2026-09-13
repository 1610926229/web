/* eslint-disable @next/next/no-img-element -- 陪玩头像为 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import type { CompanionListItem } from "@/lib/types/companion";
import { abbreviateNumber } from "@/lib/utils/format";

/**
 * 陪玩列表卡片。
 *
 * 四个区域：头像与昵称、可用状态、数据（评分 / 完成单数 / 鸡腿）、游戏与服务标签。
 *
 * 两件事是刻意的：
 *
 * 1. **可用状态不只靠颜色表达**。不可用时写出**具体原因**（「该陪玩本周已排满，暂不接单」），
 *    并且配一个实心圆点符号——只把卡片变灰的话，色觉障碍用户与黑白屏都读不出差别。
 * 2. **卡片整体是一个链接**，不可选的陪玩也能点进详情：列表上直接禁止点击，
 *    用户会觉得「这条数据坏了」，而不是「这个人现在不接单」。
 *    能不能产生选择动作，由详情页按服务端给的 `selectable` 判断。
 *
 * 卡片只画 DTO 里有的字段：没有价格（定价规则待确认）、没有等级徽章（数据模型里没有）。
 */
export default function CompanionCard({ companion }: { companion: CompanionListItem }) {
  return (
    <Link
      href={`/companions/${companion.id}`}
      className="block rounded-[12px] border border-line bg-surface p-3"
    >
      <div className="flex gap-3">
        <img
          src={companion.avatarUrl}
          alt=""
          className="h-[68px] w-[68px] shrink-0 rounded-[10px] border border-line bg-page object-cover"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            {/* 昵称可能很长（Mock 里就有一次超长昵称用例）：允许换两行，不硬截成一行 */}
            <span className="line-clamp-2 text-[15px] font-medium leading-5 text-ink">
              {companion.displayName}
            </span>
            <span
              className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4 ${
                companion.available
                  ? "bg-brand-blue-soft text-status-success"
                  : "bg-page text-status-pending"
              }`}
            >
              {/* 符号 + 文字：不靠颜色区分状态 */}
              <span aria-hidden>{companion.available ? "●" : "○"}</span>
              {companion.available ? " 可接单" : " 暂不可用"}
            </span>
          </div>

          <p className="mt-1 line-clamp-2 break-words text-[12px] leading-4 text-ink-3">
            {companion.introBrief}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
            <span>
              <span className="text-brand-yellow" aria-hidden>
                ★
              </span>{" "}
              {/* 没有评价时显示「暂无评分」，不用 0 分冒充 */}
              {companion.rating === null ? "暂无评分" : companion.rating.toFixed(1)}
              <span className="ml-1 text-ink-3">({companion.reviewCount})</span>
            </span>
            <span className="text-ink-3">{abbreviateNumber(companion.completedOrderCount)} 单</span>
            <span className="text-ink-3">鸡腿 {abbreviateNumber(companion.tipsCount)}</span>
          </div>
        </div>
      </div>

      {!companion.available && companion.unavailableReason ? (
        <p className="mt-2 rounded-[8px] bg-page px-2.5 py-1.5 text-[12px] leading-4 text-ink-2">
          {companion.unavailableReason}
        </p>
      ) : null}

      {companion.games.length > 0 || companion.serviceTags.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
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
      ) : null}
    </Link>
  );
}
