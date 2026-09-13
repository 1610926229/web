import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";

/**
 * 分类页骨架（免登录）。
 * 左侧竖向类目栏、搜索与商品列表及取数属于 P3 内容。
 */
export default function CategoryPage() {
  return (
    <>
      <NavBar title="分类" />
      <div className="flex flex-1 flex-col items-center justify-center bg-surface px-4 py-16">
        <EmptyState
          title="分类页 · 骨架"
          description="左侧竖向类目栏、搜索与商品列表待 P3 实现。"
        />
      </div>
    </>
  );
}
