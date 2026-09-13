import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";

/**
 * 订单页骨架（需登录）。
 * 订单类型、状态筛选、搜索与取数属于 P5 内容。
 */
export default function OrdersPage() {
  return (
    <>
      <NavBar title="订单" />
      <div className="flex flex-1 flex-col items-center justify-center bg-surface px-4 py-16">
        <EmptyState
          title="订单页 · 骨架"
          description="本阶段已接入登录态与鉴权拦截。订单状态筛选、搜索与列表待 P5 实现。"
        />
      </div>
    </>
  );
}
