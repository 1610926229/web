"use client";

import { useRef, useState, type ReactNode } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  COUPON_CARD_CLASS,
  COUPON_CLAIM_BUTTON_LABEL,
  COUPON_CLAIM_PENDING_LABEL,
  COUPON_CLAIMED_LABEL,
  COUPON_MOCK_NOTICE,
  COUPON_PAGE_SIZE,
  COUPON_STATUS_CLASS,
  COUPON_TABS,
  mergeCouponPage,
  type CouponTabKey,
} from "@/lib/constants/coupons";
import { claimCoupon, fetchClaimableCoupons, fetchOwnedCoupons } from "@/lib/services/couponsHttp";
import type {
  ClaimableCouponItem,
  ClaimableCouponPage,
  CouponListPage,
  CouponTabCounts,
  OwnedCouponItem,
  OwnedCouponPage,
} from "@/lib/types/coupon";
import { formatDateTime } from "@/lib/utils/format";

/** 首屏由服务端取好的那一页。两个 Tab 的形状不同，因此用可辨识联合。 */
export type CouponInitial =
  | { tab: "owned"; page: OwnedCouponPage }
  | { tab: "claimable"; page: ClaimableCouponPage };

/** 列表区域的三种状态：加载与错误只替换列表，Tab 与说明始终保留，页面不会整体白屏。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的券清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 优惠券列表（我的优惠券 / 领券中心）。
 *
 * 与订单、投诉列表同一套做法：首屏由 Server Component 取好后传进来，本组件不在挂载时
 * 再请求一次，因此首屏没有加载闪烁；之后所有请求都由用户操作触发。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。切 Tab 时先发后到的旧响应
 * 因此**不会覆盖**新 Tab 的结果——两个 Tab 的列表长得很像，这一条不处理的话非常难发现。
 *
 * 两个 Tab 各自缓存自己那一页：切回来不必重新请求，也不会因为「只存一份结果」
 * 而把另一个 Tab 的分页信息丢掉。
 *
 * 领取按钮只发起请求，**能不能领由服务端判定**：不能领时服务端返回原因，
 * 这里照原样显示在卡片旁边，而不是自己看时间推断。
 */
export default function CouponList({ initial }: { initial: CouponInitial }) {
  const [tab, setTab] = useState<CouponTabKey>(initial.tab);
  const [ownedPage, setOwnedPage] = useState<OwnedCouponPage | null>(
    initial.tab === "owned" ? initial.page : null,
  );
  const [claimablePage, setClaimablePage] = useState<ClaimableCouponPage | null>(
    initial.tab === "claimable" ? initial.page : null,
  );
  const [counts, setCounts] = useState<CouponTabCounts>(initial.page.counts);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");
  /** 正在领取的券 id；同时刻意做成「一次只允许领一张」，避免连点造成多路请求。 */
  const [claimingId, setClaimingId] = useState("");
  const [claimError, setClaimError] = useState("");
  const [claimErrorId, setClaimErrorId] = useState("");

  const ticketRef = useRef(0);
  // 「加载更多」的同步闸门：state 更新是异步的，连点两次可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);
  const claimingRef = useRef(false);

  const currentPage = tab === "owned" ? ownedPage : claimablePage;

  function applyCounts(next: CouponListPage) {
    setCounts(next.counts);
  }

  async function load(
    target: CouponTabKey,
    query: { page?: number },
    mode: "replace" | "append",
  ) {
    const ticket = ++ticketRef.current;

    if (mode === "replace") {
      setListStatus("loading");
      setListError("");
      setMoreStatus("idle");
      moreLoadingRef.current = false;
    } else {
      setMoreStatus("loading");
      setMoreError("");
      moreLoadingRef.current = true;
    }

    try {
      const paging = { page: query.page ?? 1, pageSize: COUPON_PAGE_SIZE };

      if (target === "owned") {
        const next = await fetchOwnedCoupons(paging);
        if (ticket !== ticketRef.current) return;
        setOwnedPage((current) =>
          mode === "append" && current ? mergeCouponPage(current, next) : next,
        );
        applyCounts(next);
      } else {
        const next = await fetchClaimableCoupons(paging);
        if (ticket !== ticketRef.current) return;
        setClaimablePage((current) =>
          mode === "append" && current ? mergeCouponPage(current, next) : next,
        );
        applyCounts(next);
      }

      if (mode === "append") {
        setMoreStatus("idle");
        moreLoadingRef.current = false;
      } else {
        setListStatus("ready");
      }
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      const message = cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。";
      if (mode === "replace") {
        setListStatus("error");
        setListError(message);
      } else {
        // 加载更多失败：保留已经加载出来的券，只在列表末尾提示
        setMoreStatus("error");
        setMoreError(message);
        moreLoadingRef.current = false;
      }
    }
  }

  function selectTab(next: CouponTabKey) {
    if (next === tab) return;
    setTab(next);
    setClaimError("");

    // 已经有缓存就直接显示（不发请求），否则取第一页
    const cached = next === "owned" ? ownedPage : claimablePage;
    if (cached) {
      setListStatus("ready");
      setMoreStatus("idle");
      return;
    }
    void load(next, { page: 1 }, "replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load(tab, { page: (currentPage?.page ?? 1) + 1 }, "append");
  }

  async function claim(coupon: ClaimableCouponItem) {
    if (claimingRef.current) return;

    claimingRef.current = true;
    setClaimingId(coupon.id);
    setClaimError("");
    setClaimErrorId("");

    try {
      // 幂等键：一次领取意图一个键。即便这里失败后重试换了一个键，
      // 真正防重的是服务端的「用户 + 券」唯一键，因此不会多领一张。
      await claimCoupon(coupon.id, crypto.randomUUID());
      // 领完立刻回第一页重取：卡片要变成「已领取」，两个 Tab 的角标也要跟着更新
      await load("claimable", { page: 1 }, "replace");
    } catch (cause) {
      setClaimErrorId(coupon.id);
      setClaimError(cause instanceof Error ? cause.message : "领取失败，请稍后重试。");
    } finally {
      claimingRef.current = false;
      setClaimingId("");
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 两个 Tab：切 Tab 时始终保留，只有下方列表被替换 */}
      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 py-2">
        <div className="flex gap-2" role="tablist" aria-label="优惠券分类">
          {COUPON_TABS.map((item) => {
            const active = item.key === tab;
            const count = item.key === "owned" ? counts.owned : counts.claimable;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(item.key)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[14px] leading-5 ${
                  active ? "seg-tab-active font-medium" : "bg-page text-ink-2"
                }`}
              >
                {item.label}
                <span
                  className={`rounded-full px-1.5 text-[12px] leading-4 ${
                    active ? "bg-white/25 text-white" : "bg-surface text-ink-3"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        <h2 className="text-[13px] font-medium text-ink-2">
          {COUPON_TABS.find((item) => item.key === tab)?.heading}
        </h2>
        {/* 券的性质说在明处：领了券不影响结算金额，这不是 Bug */}
        <p className="mt-1 text-[12px] leading-4 text-ink-3">{COUPON_MOCK_NOTICE}</p>

        <div className="mt-3 flex flex-1 flex-col">
          {listStatus === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-3">加载中…</p>
          ) : null}

          {listStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
              <button
                type="button"
                onClick={() => void load(tab, { page: 1 }, "replace")}
                className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                重试
              </button>
            </div>
          ) : null}

          {listStatus === "ready" && currentPage ? (
            currentPage.items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10">
                <EmptyState
                  title="暂无优惠券"
                  description={
                    tab === "owned"
                      ? "领取后的优惠券会出现在这里。"
                      : "当前没有可以领取的优惠券，稍后再来看看。"
                  }
                />
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-2.5">
                  {tab === "owned"
                    ? (ownedPage?.items ?? []).map((coupon) => (
                        <li key={coupon.id}>
                          <OwnedCouponCard coupon={coupon} />
                        </li>
                      ))
                    : (claimablePage?.items ?? []).map((coupon) => (
                        <li key={coupon.id}>
                          <ClaimableCouponCard
                            coupon={coupon}
                            claiming={claimingId === coupon.id}
                            busy={claimingId !== ""}
                            error={claimErrorId === coupon.id ? claimError : ""}
                            onClaim={() => void claim(coupon)}
                          />
                        </li>
                      ))}
                </ul>

                <div className="mt-3">
                  {currentPage.hasMore ? (
                    <button
                      type="button"
                      disabled={moreStatus === "loading"}
                      onClick={loadMore}
                      className="w-full rounded-full border border-line py-2 text-[13px] text-ink-2 disabled:opacity-60"
                    >
                      {moreStatus === "loading" ? "加载中…" : "加载更多"}
                    </button>
                  ) : (
                    // 「没有更多了」与「列表为空」是两个不同的状态，不能合并成一句话
                    <p className="text-center text-[12px] text-ink-3">没有更多了</p>
                  )}

                  {moreStatus === "error" ? (
                    <div className="mt-2 flex flex-col items-center gap-2">
                      <p className="text-center text-[12px] leading-5 text-ink-3">{moreError}</p>
                      <button
                        type="button"
                        onClick={loadMore}
                        className="text-[12px] text-brand-blue underline"
                      >
                        重试
                      </button>
                    </div>
                  ) : null}
                </div>
              </>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 券卡片外壳：券面值 + 形式 + 条件 + 有效期，右侧是状态或领取按钮。 */
function CouponCard({
  name,
  formLabel,
  valueLabel,
  conditionLabel,
  validFrom,
  validTo,
  status,
  children,
}: {
  name: string;
  formLabel: string;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  status?: OwnedCouponItem["status"];
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-stretch gap-3 rounded-[10px] border bg-surface p-3 ${
        status ? COUPON_CARD_CLASS[status] : "border-line"
      }`}
    >
      <div className="flex w-[86px] shrink-0 flex-col items-center justify-center border-r border-dashed border-line pr-3">
        <span className="text-[17px] font-semibold leading-6 text-brand-red">{valueLabel}</span>
        <span className="mt-0.5 text-[11px] text-ink-3">{formLabel}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <p className="line-clamp-1 text-[14px] font-medium text-ink">{name}</p>
        <p className="mt-1 text-[12px] leading-4 text-ink-2">{conditionLabel}</p>
        {/* 有效期写明到日：券是不是快到期了，用户一眼能看出来 */}
        <p className="mt-1 break-words text-[11px] leading-4 text-ink-3">
          有效期 {formatDate(validFrom)} 至 {formatDate(validTo)}
        </p>
        {children}
      </div>
    </div>
  );
}

/** 已拥有的券：右侧只显示状态。 */
function OwnedCouponCard({ coupon }: { coupon: OwnedCouponItem }) {
  return (
    <CouponCard {...coupon} status={coupon.status}>
      <p className={`mt-1.5 text-[13px] font-medium ${COUPON_STATUS_CLASS[coupon.status]}`}>
        {coupon.statusLabel}
        {coupon.usedAt ? ` · ${formatDateTime(coupon.usedAt)}` : ""}
      </p>
    </CouponCard>
  );
}

/**
 * 领券中心的券：右侧是「立即领取」按钮或状态。
 *
 * 不能领取时按钮**不做成灰色哑巴按钮**：旁边一定有一句说明为什么领不了
 * （已停用 / 已过期 / 尚未开始 / 已领取），按钮本身也带上同样的说明作为无障碍名称。
 */
function ClaimableCouponCard({
  coupon,
  claiming,
  busy,
  error,
  onClaim,
}: {
  coupon: ClaimableCouponItem;
  claiming: boolean;
  busy: boolean;
  error: string;
  onClaim: () => void;
}) {
  return (
    <CouponCard
      {...coupon}
      status={coupon.claimed ? "used" : coupon.claimable ? "unused" : "expired"}
    >
      <div className="mt-2 flex items-center gap-2">
        {coupon.claimable ? (
          <button
            type="button"
            disabled={busy}
            aria-label={`领取 ${coupon.name}`}
            onClick={onClaim}
            className="h-8 shrink-0 rounded-full bg-brand-red px-4 text-[13px] font-medium text-white disabled:opacity-60"
          >
            {claiming ? COUPON_CLAIM_PENDING_LABEL : COUPON_CLAIM_BUTTON_LABEL}
          </button>
        ) : (
          <>
            <span
              className="flex h-8 shrink-0 items-center rounded-full border border-line px-4 text-[13px] text-ink-3"
              aria-disabled
            >
              {coupon.claimed ? COUPON_CLAIMED_LABEL : "不可领取"}
            </span>
            {/* 不能领取的原因就写在按钮旁边，不让用户对着灰按钮猜 */}
            <span className="min-w-0 flex-1 text-[12px] leading-4 text-ink-3">{coupon.reason}</span>
          </>
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-1.5 text-[12px] leading-4 text-brand-red">
          {error}
        </p>
      ) : null}
    </CouponCard>
  );
}

/** 只取日期部分（有效期按天看就够，写全时间反而更难读）。 */
function formatDate(iso: string): string {
  return formatDateTime(iso).slice(0, 10);
}
