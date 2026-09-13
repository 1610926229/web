import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import PriceText from "@/components/common/PriceText";
import MockPaymentActions from "@/components/payment/MockPaymentActions";
import RequireAuth from "@/lib/auth/RequireAuth";
import { isMockPaymentEnabled } from "@/lib/config/env";
import { getOrderForUser, getPaymentRequestForUser } from "@/lib/services/checkout";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 支付结果页（需登录）。
 *
 * 一条硬规则：**地址里的东西不算数**。
 * `requestId` 只是「查哪一条」的键，页面渲染的状态一律由服务端按这个 id 现读：
 * 即便有人把地址改成 `?requestId=xxx&status=success`，服务端也不会去读第二个参数。
 * 归属同样由服务端校验——拿别人的 requestId 进来，只会看到「无权查看」。
 *
 * 结果因此是刷新稳定的：这一页没有本地状态，刷新等于重新问一次服务端的真实状态。
 *
 * 该路由位于 `(tabs)` 之外，不显示底部 TabBar。未登录时由统一的登录守卫拦截。
 */
export default async function PayResultPage({ searchParams }: PageProps<"/pay/result">) {
  const query = toSearchParams(await searchParams);
  const requestId = (query.get("requestId") ?? "").trim();
  const mockPaymentEnabled = isMockPaymentEnabled();

  return (
    <>
      <NavBar title="支付结果" />

      <RequireAuth>
        {(user) => (
          <ResultBody
            requestId={requestId}
            userId={user.id}
            mockPaymentEnabled={mockPaymentEnabled}
          />
        )}
      </RequireAuth>
    </>
  );
}

async function ResultBody({
  requestId,
  userId,
  mockPaymentEnabled,
}: {
  requestId: string;
  userId: string;
  mockPaymentEnabled: boolean;
}) {
  if (!requestId) {
    return (
      <Panel
        tone="muted"
        title="支付请求不存在"
        description="没有收到支付请求编号，无法查询支付结果。"
        actions={<HomeLink />}
      />
    );
  }

  const lookup = await getPaymentRequestForUser(requestId, userId);
  if (!lookup.ok) {
    if (lookup.reason === "forbidden") {
      return (
        <Panel
          tone="muted"
          title="无权查看该支付请求"
          description="这条支付请求不属于当前登录账号。"
          actions={<HomeLink />}
        />
      );
    }
    return (
      <Panel
        tone="muted"
        title="支付请求不存在"
        description="该支付请求可能已失效，或开发服务器重启后内存数据被清空。"
        actions={<HomeLink />}
      />
    );
  }

  const request = lookup.request;

  if (request.status === "success") {
    const order = request.orderId ? await getOrderForUser(request.orderId, userId) : null;

    return (
      <Panel
        tone="success"
        title="支付成功"
        description="订单已生成，陪玩接单与后续进度可稍后在订单列表查看。"
        amount={request.totalAmount}
        actions={
          <>
            {/* 直接进入这一单的详情；订单一时取不到时退回列表，绝不给出指向不存在订单的链接 */}
            <Link
              href={order ? `/orders/${order.id}` : "/orders"}
              className="flex h-11 items-center justify-center rounded-full bg-brand-red px-8 text-[15px] font-medium text-white"
            >
              查看订单
            </Link>
            <Link
              href="/orders"
              className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
            >
              查看全部订单
            </Link>
            <HomeLink />
          </>
        }
      >
        <DetailRow label="商品" value={request.snapshot.productTitle} />
        <DetailRow
          label="规格 / 数量"
          value={`${request.snapshot.specName} × ${request.quantity}`}
        />
        <DetailRow label="游戏 ID" value={request.gameAccountId} />
        <DetailRow
          label="陪玩"
          value={request.snapshot.companion ? request.snapshot.companion.name : "未选择（待接单或平台分配）"}
        />
        {order ? <DetailRow label="订单号" value={order.orderNo} /> : null}
      </Panel>
    );
  }

  if (request.status === "failed" || request.status === "cancelled") {
    const cancelled = request.status === "cancelled";
    return (
      <Panel
        tone="muted"
        title={cancelled ? "已取消支付" : "支付失败"}
        description={
          cancelled
            ? "本次支付已取消，未生成订单，也不会产生任何扣款。"
            : "本次支付未完成，未生成订单，也不会产生任何扣款。"
        }
        amount={request.totalAmount}
        actions={
          <>
            <RetryLink productId={request.productId} specId={request.specId} />
            <HomeLink />
          </>
        }
      >
        <DetailRow label="商品" value={request.snapshot.productTitle} />
        <DetailRow label="规格 / 数量" value={`${request.snapshot.specName} × ${request.quantity}`} />
      </Panel>
    );
  }

  // 待支付：还没有结果。真实支付渠道未接入，这里只能由开发用的模拟支付给出结果。
  return (
    <Panel
      tone="pending"
      title="待支付"
      description={
        mockPaymentEnabled
          ? "支付尚未完成，请在下方选择模拟支付结果以继续验证流程。"
          : "支付尚未完成。当前未开启模拟支付，无法在本地完成这笔支付。"
      }
      amount={request.totalAmount}
      actions={
        <>
          <RetryLink productId={request.productId} specId={request.specId} label="返回结算页" />
          <HomeLink />
        </>
      }
    >
      <DetailRow label="商品" value={request.snapshot.productTitle} />
      <DetailRow label="规格 / 数量" value={`${request.snapshot.specName} × ${request.quantity}`} />

      {mockPaymentEnabled ? <MockPaymentActions requestId={request.id} /> : null}
    </Panel>
  );
}

/** 结果面板：状态图标 + 文案 + 金额 + 明细 + 操作。 */
function Panel({
  tone,
  title,
  description,
  amount,
  actions,
  children,
}: {
  tone: "success" | "pending" | "muted";
  title: string;
  description: string;
  amount?: number;
  actions: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center overflow-x-clip bg-page px-4 py-8">
      <StatusIcon tone={tone} />

      <h2 className="mt-3 text-[19px] font-semibold text-ink">{title}</h2>
      <p className="mt-2 text-center text-[13px] leading-5 text-ink-3">{description}</p>

      {typeof amount === "number" ? (
        <PriceText cents={amount} className="mt-4 text-[26px] text-brand-red" />
      ) : null}

      {children ? (
        <div className="mt-5 w-full rounded-[10px] bg-surface px-4 py-3">{children}</div>
      ) : null}

      <div className="mt-6 flex w-full flex-col items-center gap-3">{actions}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-right text-ink">{value}</span>
    </div>
  );
}

function StatusIcon({ tone }: { tone: "success" | "pending" | "muted" }) {
  if (tone === "success") {
    return (
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-red">
        <svg
          viewBox="0 0 24 24"
          className="h-8 w-8"
          fill="none"
          stroke="#fff"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
    );
  }

  if (tone === "pending") {
    return (
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#ffb300]">
        <svg
          viewBox="0 0 24 24"
          className="h-8 w-8"
          fill="none"
          stroke="#fff"
          strokeWidth={2.2}
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 8v4.5l3 1.8" />
        </svg>
      </span>
    );
  }

  return (
    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-line">
      <svg
        viewBox="0 0 24 24"
        className="h-8 w-8"
        fill="none"
        stroke="#8a8f99"
        strokeWidth={2.2}
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M12 7.5v5.5" />
        <path d="M12 16.5h.01" />
        <circle cx="12" cy="12" r="8.5" />
      </svg>
    </span>
  );
}

function RetryLink({
  productId,
  specId,
  label = "重新支付",
}: {
  productId: string;
  specId: string;
  label?: string;
}) {
  const query = new URLSearchParams({ productId, specId });
  return (
    <Link
      href={`/checkout?${query.toString()}`}
      className="flex h-11 items-center justify-center rounded-full bg-brand-red px-8 text-[15px] font-medium text-white"
    >
      {label}
    </Link>
  );
}

function HomeLink() {
  return (
    <Link
      href="/"
      className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
    >
      返回首页
    </Link>
  );
}
