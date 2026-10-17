import CompanionDispatchCard from "@/components/companion/CompanionDispatchCard";
import type { CompanionPoolItem } from "@/lib/types/dispatch";

/**
 * 订单池列表（P0-5）—— 两张池子页共用的那一张表。
 *
 * ⚠️ **本组件与两张页面都不读数据**：池子由服务端页面 `listCompanionPools()` 取好
 * 传进来。这里只负责排布，因此不存在「页面读一次、组件再读一次」这种两份结果。
 *
 * ⚠️ 空态的文案由调用方给（`emptyText`），不在这里按 `items.length === 0` 猜是哪张池子：
 * 「目前没有用户指定给你的订单」与「公共池暂时是空的」说的不是同一件事。
 *
 * ⚠️ `canAccept` 同样由调用方给，而且**必须一路传到卡片**：它决定卡片上有没有接单按钮。
 * 在这里按「`items` 是不是空的」反推是错的——专属池在暂停接单时**照样有内容**，
 * 而那时按钮同样不该出现。
 */
export default function CompanionDispatchTable({
  items,
  emptyText,
  canAccept,
}: {
  items: readonly CompanionPoolItem[];
  emptyText: string;
  /** 来自同一次池子读取的 `CompanionPoolData.canAccept`，页面不自己推断 */
  canAccept: boolean;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-2xl border border-line px-4 py-8 text-center text-[13px] text-ink-3">
        {emptyText}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <CompanionDispatchCard key={item.dispatchId} item={item} canAccept={canAccept} />
      ))}
    </ul>
  );
}
