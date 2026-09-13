/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import type { Product } from "@/lib/types/product";
import PriceText from "./PriceText";

/**
 * 首页 / 分类页商品卡片。封面与标题进入商品详情，右下角为购买按钮。
 *
 * `compact` 供**分类页右侧双列**使用：那一列在 375px 屏上只有约 130px 宽，
 * 首页那套「立即购买 + 箭头圆标」的胶囊会把价格挤到重叠，因此缩小字号并简化为「购买」。
 * 首页不传该参数，默认分支与 P1 已确认的视觉**逐字未变**。
 */
export default function ProductCard({
  product,
  compact = false,
}: {
  product: Product;
  compact?: boolean;
}) {
  const detailHref = `/product/${product.id}`;

  return (
    <article className="flex flex-col">
      <Link href={detailHref} className="block">
        <div className="aspect-square w-full overflow-hidden rounded-[10px] border border-brand-blue-border bg-brand-blue-soft">
          <img
            src={product.coverUrl}
            alt={product.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </div>
      </Link>

      <h3
        className={`mt-2 line-clamp-1 font-semibold text-ink ${
          compact ? "text-[14px]" : "text-[15px]"
        }`}
      >
        {product.title}
      </h3>
      <p className={`mt-0.5 line-clamp-1 text-ink-3 ${compact ? "text-[12px]" : "text-[13px]"}`}>
        {product.subtitle}
      </p>

      <div className={`flex items-center justify-between gap-2 ${compact ? "mt-1.5" : "mt-2"}`}>
        <PriceText
          cents={product.price}
          className={`text-brand-red ${compact ? "text-[15px]" : "text-[17px]"}`}
        />

        {compact ? (
          <Link
            href={detailHref}
            className="shrink-0 rounded-full bg-ink px-3 py-[5px] text-[12px] font-medium text-white"
          >
            购买
          </Link>
        ) : (
          <Link
            href={detailHref}
            className="flex shrink-0 items-center gap-1 rounded-full bg-ink py-[6px] pl-3 pr-2 text-[13px] font-medium text-white"
          >
            立即购买
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-ink">
              <svg
                viewBox="0 0 24 24"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </span>
          </Link>
        )}
      </div>
    </article>
  );
}
