import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import EmptyState from "@/components/common/EmptyState";
import RequireAuth from "@/lib/auth/RequireAuth";

/**
 * 结算占位页（需登录）。
 *
 * P4 才实现结算，这里只是「立即购买」登录成功后的落点，**不生成订单、不结算金额、不发起支付**。
 *
 * 该路由位于 `(tabs)` 之外（结算不显示底部 TabBar，用户应专注于当前这一单）。
 * NavBar 放在 `RequireAuth` 外面：未登录时也能返回上一页，不会卡在登录拦截界面上。
 */
export default function CheckoutPage() {
  return (
    <>
      <NavBar title="确认订单" showBack />

      <RequireAuth>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
          <EmptyState
            title="结算流程待实现"
            description="下单、金额结算与支付属于 P4 内容，当前仅为占位页面。"
          />

          <Link
            href="/category"
            className="rounded-full border border-line px-6 py-2 text-[14px] text-ink-2"
          >
            继续逛逛
          </Link>
        </div>
      </RequireAuth>
    </>
  );
}
