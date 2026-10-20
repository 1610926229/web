import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import ReviewForm from "@/components/reviews/ReviewForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { REVIEW_ALREADY_REVIEWED_MESSAGE } from "@/lib/constants/reviews";
import { getReviewTargetForUser } from "@/lib/services/reviews";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 发表 / 重新提交评价页（需登录）。
 *
 * **这一页不判断「能不能评价」**：判定只在服务端做一次（`getReviewTargetForUser`），
 * 页面照着它的**五种**结果显示表单或说明。理由是「能不能评价」看的是这一单
 * 有没有真实的完成时间（`D19`），以及有没有评价记录，前端拿订单状态自己推断一定算错。
 *
 * 五种结果各自落到哪一块：
 * - `missing`  → 「订单不存在」说明页；
 * - `reviewed` → 「该订单已评价过」（作者看得见状态，`D8`）；
 * - `rejected` → **重新提交模式**的表单（用原内容预填，`D9` 的唯一回表单入口）；
 * - `blocked`  → 「当前不可评价」说明页（原因由服务端给出）；
 * - `ready`    → 新建模式的表单。
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

  // 已经评价过：把用户引到评价列表，而不是给一句「不可评价」就结束。
  // ⚠️ 这里只说**状态**（`statusLabel`，由服务端给），不再引用单个星级——
  // 一条评价最多有两个星级，挑一个显示等于替用户决定哪个更代表这次消费。
  if (target.status === "reviewed") {
    const { review } = target;
    return (
      <Notice
        title={REVIEW_ALREADY_REVIEWED_MESSAGE}
        description={`一笔订单只能评价一次。当前评价：${review.statusLabel}，提交于 ${formatDateTime(review.createdAt)}。`}
        href="/reviews"
        linkLabel="查看我的评价"
      />
    );
  }

  // 被驳回：这是**唯一**能回到表单的状态（D9）。页面把原内容预填进表单，
  // 用户改完重提，落点仍是同一条评价（不会变成「第二条」）。
  if (target.status === "rejected") {
    return (
      <div className="flex flex-1 flex-col overflow-x-clip">
        <ReviewForm mode="resubmit" review={target.review} />
      </div>
    );
  }

  // 订单本身不可评价（还没完成过服务），原因由服务端给出
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
      <ReviewForm mode="create" order={target.order} />
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
