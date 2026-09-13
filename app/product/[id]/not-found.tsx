import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import EmptyState from "@/components/common/EmptyState";

/**
 * 商品不存在。
 *
 * 与「商品已下架」区分开：下架商品仍能打开详情（页面上标记已下架、不可购买），
 * 这里是商品 ID 根本取不到数据，属于链接失效。
 */
export default function ProductNotFound() {
  return (
    <>
      <NavBar title="商品详情" showBack />

      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState title="商品不存在" description="该商品可能已被删除，或链接已失效。" />

        <Link
          href="/category"
          className="rounded-full border border-line px-6 py-2 text-[14px] text-ink-2"
        >
          去分类页看看
        </Link>
      </div>
    </>
  );
}
