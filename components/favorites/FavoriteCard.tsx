/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import PriceText from "@/components/common/PriceText";
import { FAVORITE_MISSING_NOTE, FAVORITE_OFF_SHELF_NOTE } from "@/lib/constants/favorites";
import type { FavoriteListItem } from "@/lib/types/favorite";

/**
 * 收藏列表的紧凑卡片：封面 + 商品名 + 规格 + 当前价格 + 移除。
 *
 * 展示的是商品的**当前**信息（收藏不存交易快照），因此商品改名改价后这里跟着变。
 *
 * 三种状态各有各的画法：
 * - `available`：正常可点，进商品详情；
 * - `off_shelf`：仍可点进详情（详情页会如实显示下架、不给买），卡片上标注「已下架」；
 * - `missing`：商品已被删除，**没有可跳转的页面**，因此这一行不做成链接（点了必然 404），
 *   只显示占位块 + 说明 + 移除按钮——收藏记录还在，用户需要能把它清掉。
 *
 * 卡片整体不是链接：里面有「移除」按钮，套在链接里会产生嵌套交互元素。
 * 因此可点击的是封面与标题，它们各自是链接。
 */
export default function FavoriteCard({
  item,
  removing,
  onRemove,
}: {
  item: FavoriteListItem;
  removing: boolean;
  onRemove: (item: FavoriteListItem) => void;
}) {
  const product = item.product;
  const detailHref = `/product/${item.productId}`;
  // 商品已不存在时没有详情页可去，整行不做成链接
  const linked = item.state !== "missing";

  return (
    <article className="flex gap-3 rounded-[10px] bg-surface p-3">
      {linked ? (
        <Link href={detailHref} className="shrink-0">
          <img
            src={product?.coverUrl ?? ""}
            alt={product?.title ?? ""}
            loading="lazy"
            className="h-20 w-20 rounded-[8px] border border-line object-cover"
          />
        </Link>
      ) : (
        <span
          aria-hidden
          className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[8px] bg-page text-ink-3"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4" y="5" width="16" height="14" rx="2" />
            <path d="M8 10h8" />
            <path d="M8 14h5" />
          </svg>
        </span>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {linked ? (
          <Link href={detailHref} className="min-w-0">
            <h3 className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
              {product?.title}
            </h3>
          </Link>
        ) : (
          <h3 className="line-clamp-2 text-[14px] font-medium leading-5 text-ink-3">
            商品已不存在
          </h3>
        )}

        {product ? (
          <>
            <p className="mt-1 truncate text-[12px] text-ink-3">{product.subtitle}</p>
            <p className="mt-1">
              <PriceText cents={product.price} className="text-[15px] text-brand-red" />
            </p>
          </>
        ) : null}

        {item.state !== "available" ? (
          <p className="mt-1 text-[12px] leading-4 text-status-pending">
            {item.state === "off_shelf" ? FAVORITE_OFF_SHELF_NOTE : FAVORITE_MISSING_NOTE}
          </p>
        ) : null}

        <div className="mt-auto flex justify-end pt-1.5">
          <button
            type="button"
            disabled={removing}
            onClick={() => onRemove(item)}
            aria-label={`移除收藏：${product?.title ?? item.productId}`}
            className="rounded-full border border-line px-3 py-1 text-[12px] text-ink-2 disabled:opacity-60"
          >
            {removing ? "移除中…" : "移除"}
          </button>
        </div>
      </div>
    </article>
  );
}
