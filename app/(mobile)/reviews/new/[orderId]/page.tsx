import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import ReviewForm from "@/components/reviews/ReviewForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { REVIEW_RATING_LABELS } from "@/lib/constants/reviews";
import { getReviewTargetForUser } from "@/lib/services/reviews";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 发表评价页（需登录）。
 *
 * **这一页不判断「能不能评价」**：判定只在服务端做一次（`getReviewTargetForUser`），
 * 页面照着它给出的四种结果显示表单或说明。理由是「能不能评价」既看订单状态、
 * 也看这一单有没有评价记录、有没有进行中 / 已通过的退款，前端只看状态一定算错。
 *
 * 即使有人绕过这一页直接调接口，服务端也会再校验一次；这个页面只是把结果如实呈现出来。
 *
 * 订单不存在与不属于当前用户**返回同一个「订单不存在」**，因此不能拿订单 id 试探别人有哪些订单。
 */
export default async function ReviewCreatePage({ params }: PageProps<"/reviews/new/[orderId]">) {
  const { orderId } = await params;

  return (
    <>
      <NavBar title="发表评价" showBack />

      <RequireAuth>
        {(user) => <ReviewCreateBody orderId={orderId ?? ""} userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function ReviewCreateBody({ orderId, userId }: { orderId: string; userId: string }) {
  const target = await getReviewTargetForUser(orderId, userId, undefined, "server");

  if (target.status === "missing") {
    return (
      <Notice
        title="订单不存在"
        description="该订单可能不属于当前登录账号，或开发服务器重启后内存数据被清空。"
        href="/orders"
        linkLabel="返回订单列表"
      />
    );
  }

  // 已经评价过：把用户引到评价列表，而不是给一句「不可评价」就结束
  if (target.status === "reviewed") {
    const { review } = target;
    return (
      <Notice
        title="该订单已评价过"
        description={`一笔订单只能评价一次。当前评价：${REVIEW_RATING_LABELS[review.rating]}，${formatDateTime(review.createdAt)}。`}
        href="/reviews"
        linkLabel="查看我的评价"
      />
    );
  }

  // 订单状态本身不可评价（未完成 / 退款中 / 已退款），原因由服务端给出
  if (target.status === "blocked") {
    return (
      <Notice
        title="该订单当前不可评价"
        description={`${target.reason}。订单当前状态：${ORDER_STATUS_LABELS[target.orderStatus]}。`}
        href={`/orders/${orderId}`}
        linkLabel="返回订单详情"
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-x-clip">
      <ReviewForm order={target.order} />
    </div>
  );
}

/** 不能评价时的说明页：一句原因 + 一个能继续走下去的出口。 */
function Notice({
  title,
  description,
  href,
  linkLabel,
}: {
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
      <EmptyState title={title} description={description} />
      <Link
        href={href}
        className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
      >
        {linkLabel}
      </Link>
    </div>
  );
}
