import Link from "next/link";
import ProductCard from "@/components/common/ProductCard";
import type { ProductSection as ProductSectionData } from "@/lib/types/content";

/**
 * 首页商品分组：居中黄色分组标题 + 右侧「查看更多」+ 双列商品卡。
 */
export default function ProductSection({ section }: { section: ProductSectionData }) {
  return (
    <section className="mt-2 bg-surface pb-4 pt-2">
      <div className="relative flex h-11 items-center justify-center">
        <h2 className="relative rounded-[10px] bg-brand-yellow px-6 py-[6px] text-[16px] font-bold text-ink-2">
          {section.title}
          {/* 分组标题下方的燕尾，与原型一致 */}
          <span
            className="absolute left-1/2 top-full h-[9px] w-[9px] -translate-x-1/2 -translate-y-[5px] rotate-45 bg-brand-yellow"
            aria-hidden
          />
        </h2>

        <Link
          href={section.moreHref}
          className="absolute right-3 flex items-center gap-0.5 text-[14px] text-ink-2"
        >
          查看更多
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-4 px-3">
        {section.products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}
