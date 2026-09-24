/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { notFound } from "next/navigation";
import CompanionOrderCancelPanel from "@/components/companion/CompanionOrderCancelPanel";
import PriceText from "@/components/common/PriceText";
import { getSessionUser } from "@/lib/auth/session";
import {
  COMPANION_ORDER_CANCEL_UNAVAILABLE_NOTICE,
  COMPANION_ORDER_DETAIL_PAGE_TITLE,
  COMPANION_ORDERS_BACK_LABEL,
} from "@/lib/constants/dispatch";
import { ORDER_STATUS_CLASS } from "@/lib/constants/orders";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { getCompanionOrderDetail } from "@/lib/services/companionOrders";
import type { CompanionOrderDetail } from "@/lib/types/order";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 订单详情（P0-6，`/companion/orders/[id]`）—— 履约所需的全部信息 + 取消接单入口。
 *
 * ## 取不到就是 404，而不是「查不到」
 *
 * 服务层**重新校验归属**（`Order.actualCompanionId === 当前 companionId`），
 * 订单不存在、或存在但不是他接的单，对外表现完全一致 → `notFound()`。列表入口隐藏
 * 不是保护：接口可以被直接请求，因此不能只靠「列表里没有这一单」。
 *
 * ⚠️ 本路由上下**没有 `loading.tsx`**，这与 `app/admin/(console)/orders/[id]/` 是
 * 同一条理由：加载边界一旦罩住它，外壳会先以 200 发出，迟到的 `notFound()` 只能改内容、
 * 改不了状态码，「不是你的订单」就变成一屏 200 的 404 文案。
 * 兄弟目录用 `(list)` 分组隔开（admin 的做法）会改变本轮已冻结的落点，因此这里
 * 让整棵 `orders/` 都不挂 loading 边界。
 *
 * ## 只渲染服务端给的字段
 *
 * `gameAccountId` 与 `remark` **只在这个接口上出现**（公共池的 DTO 刻意没有它们）：
 * 接单之前打手没有理由看到别人的游戏账号，接单之后没有账号与备注就打不了这一单。
 * 金额只显示商品与增值服务（`unitPrice` / `itemsAmount` / `addonsAmount` / `totalAmount`）
 * ——打手端 DTO 上**没有**平台净收入、分账比例、护航收益与已退金额，这一页也就无从显示。
 *
 * ⚠️ 能不能取消**不在这里判断**：`detail.canCancel` 由服务端算好（就是
 * `status === "accepted"`），页面只按它显示或隐藏入口。前端拿状态自己推一遍，
 * 就是在页面这一层再写一份规则，而真正的保护在 `cancelAcceptedOrder` 的原子区段里。
 *
 * ## 为什么这一页自己读资格
 *
 * 取详情需要**当前打手的 id**，而布局无法给 `children` 传 props；
 * `getSessionUser` 与 `resolveCompanionAccess` 都被 `React.cache` 包着，
 * 因此这一次读取与布局那一次是**同一个结果**（与 `pool` / `exclusive` 两页同一条理由）。
 */
export default async function CompanionOrderDetailPage({
  params,
}: PageProps<"/companion/orders/[id]">) {
  const { id } = await params;

  const user = await getSessionUser();
  // 未登录时布局已经在渲染用户端的登录控件；这里什么都不做
  if (!user) return null;

  const access = await resolveCompanionAccess(user.id);
  // 不是护航 / 资格已下架：布局已经渲染了对应的提示页
  if (access.kind !== "granted") return null;

  const detail = await getCompanionOrderDetail(access.companion.companionId, id);
  if (!detail) notFound();

  return (
    <>
      <h2 className="text-[14px] font-semibold text-ink">{COMPANION_ORDER_DETAIL_PAGE_TITLE}</h2>

      <StatusSection detail={detail} />
      <ProductSection detail={detail} />
      <OrderInfoSection detail={detail} />
      <CustomerSection detail={detail} />

      {/*
        取消接单入口。**只有 `canCancel` 为真时才有那个按钮**（`serving` 不显示普通
        取消按钮）；不能取消时留一句解释，而不是让那一块凭空消失——按钮不见了而
        没有任何说明，打手只会以为页面坏了。
      */}
      {detail.canCancel ? (
        <CompanionOrderCancelPanel orderId={detail.id} />
      ) : (
        <section className="rounded-2xl border border-line px-4 py-4">
          <p className="text-[12px] leading-5 text-ink-3">
            {COMPANION_ORDER_CANCEL_UNAVAILABLE_NOTICE}
          </p>
        </section>
      )}

      <div className="flex justify-center pb-2">
        <Link
          href="/companion/orders"
          className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
        >
          {COMPANION_ORDERS_BACK_LABEL}
        </Link>
      </div>
    </>
  );
}

/** 状态区：状态名与状态色都取自同一套常量，页面不硬编码颜色。 */
function StatusSection({ detail }: { detail: CompanionOrderDetail }) {
  return (
    <section className="rounded-2xl border border-line px-4 py-4">
      {/* 状态中文名由服务端给（`statusLabel`），页面不自己维护一份文案 */}
      <p className={`text-[16px] font-semibold ${ORDER_STATUS_CLASS[detail.status]}`}>
        {detail.statusLabel}
      </p>

      <div className="mt-2">
        <DetailRow label="订单号" value={detail.orderNo} />
        <DetailRow label="下单时间" value={formatDateTime(detail.paidAt)} />
        {/* 接单时间缺失（历史数据）时如实显示空值，不编一个时刻 */}
        <DetailRow
          label="接单时间"
          value={detail.acceptedAt ? formatDateTime(detail.acceptedAt) : ""}
        />
      </div>
    </section>
  );
}

/**
 * 商品与金额。
 *
 * 展示的全是**下单那一刻的快照**：之后改价、换图、下架、改名都不影响这一页
 * ——打手要照这一单当时买的东西服务。
 *
 * 金额只到「商品 + 增值服务」为止：平台净收入、分账比例与护航收益都不在打手端 DTO 上，
 * 因此这里没有、也不该有任何分账口径。
 */
function ProductSection({ detail }: { detail: CompanionOrderDetail }) {
  return (
    <section className="rounded-2xl border border-line px-4 py-4">
      <h2 className="text-[14px] font-semibold text-ink">商品信息</h2>

      <div className="mt-2 flex gap-3">
        <img
          src={detail.productCoverUrl}
          alt={detail.productTitle}
          className="h-16 w-16 shrink-0 rounded-[8px] border border-line object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
            {detail.productTitle}
          </p>
          <p className="mt-1 break-words text-[12px] leading-4 text-ink-3">{detail.specName}</p>
        </div>
      </div>

      <div className="mt-2">
        <MoneyRow label="单价" cents={detail.unitPrice} />
        <DetailRow label="数量" value={`×${detail.quantity}`} />
        <MoneyRow label="商品金额" cents={detail.itemsAmount} />

        {detail.addons.map((addon) => (
          <MoneyRow key={addon.id} label={`增值服务 · ${addon.name}`} cents={addon.price} />
        ))}
        {detail.addons.length > 0 ? (
          <MoneyRow label="增值服务合计" cents={detail.addonsAmount} />
        ) : (
          <DetailRow label="增值服务" value="无" />
        )}
        <MoneyRow label="订单合计" cents={detail.totalAmount} />
      </div>
    </section>
  );
}

/**
 * 订单信息：游戏 / 大区 / 游戏账号 / 用户备注。
 *
 * ⚠️ 前三项与备注**是这一页存在的理由之一**：没有游戏账号与备注就打不了这一单。
 * 它们出现在**接单之后**的详情里（公共池的 DTO 刻意不带），而不是「打手能看的都给」。
 */
function OrderInfoSection({ detail }: { detail: CompanionOrderDetail }) {
  return (
    <section className="rounded-2xl border border-line px-4 py-4">
      <h2 className="text-[14px] font-semibold text-ink">服务信息</h2>
      <div className="mt-1">
        <DetailRow label="游戏" value={detail.gameName} />
        <DetailRow label="大区" value={detail.region} />
        <DetailRow label="游戏账号" value={detail.gameAccountId} />
        <DetailRow label="用户备注" value={detail.remark || "无"} />
      </div>
    </section>
  );
}

/**
 * 下单用户的称呼。
 *
 * DTO 里**只有昵称**：没有联系方式、没有平台展示 ID、没有头像——打手与用户的联系
 * 发生在聊天里（后续批次），订单详情不需要带出更多身份信息。
 * 查不到用户记录时是空串，这时显示空值而不是让整页报错：订单本身是有效的。
 */
function CustomerSection({ detail }: { detail: CompanionOrderDetail }) {
  return (
    <section className="rounded-2xl border border-line px-4 py-4">
      <h2 className="text-[14px] font-semibold text-ink">下单用户</h2>
      <div className="mt-1">
        <DetailRow label="昵称" value={detail.customerNickname} />
      </div>
    </section>
  );
}

/** 明细行：左标签右内容，长内容换行而不是把卡片撑宽。空值显示「—」。 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-right text-ink">{value || "—"}</span>
    </div>
  );
}

/** 金额行：一律经 `PriceText`，两位小数的口径只有 `lib/utils/format.ts` 一处实现。 */
function MoneyRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
      <span className="min-w-0 flex-1 break-words text-ink-3">{label}</span>
      <PriceText cents={cents} className="shrink-0 text-[13px] text-ink" />
    </div>
  );
}
