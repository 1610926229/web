import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";

/**
 * 客服页骨架（需登录）。
 * 订单沟通、联系客服与系统通知属于 P5 内容。
 */
export default function ServicePage() {
  return (
    <>
      <NavBar title="客服" />
      <div className="flex flex-1 flex-col items-center justify-center bg-surface px-4 py-16">
        <EmptyState
          title="客服页 · 骨架"
          description="本阶段已接入登录态与鉴权拦截。订单沟通、联系客服与系统通知待 P5 实现。"
        />
      </div>
    </>
  );
}
