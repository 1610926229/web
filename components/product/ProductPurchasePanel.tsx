"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import PriceText from "@/components/common/PriceText";
import LoginSheet from "@/components/auth/LoginSheet";
import { abbreviateNumber, formatYuan } from "@/lib/utils/format";
import type { ProductDetail } from "@/lib/types/product";

/** 需要登录的操作。游客点击时统一走登录流程，不在本组件里另写一套判断。 */
type GatedAction = "service" | "favorite" | "buy";

/**
 * 商品详情的商品信息、规格选择与底部操作栏。
 *
 * 客户端组件的原因有二：规格选择是需要即时响应的本地状态；受限操作要弹登录浮层。
 * 首屏内容（标题、月售、价格、规格）依然由它 SSR 输出，不会因为标记了 "use client" 就变空。
 *
 * `loggedIn` 由服务端读取会话后传入——是否登录只由服务端说了算，客户端不自行判断，
 * 也不重复拉取登录态。登录成功后 `router.refresh()` 会让这个值变为 true。
 */
export default function ProductPurchasePanel({
  product,
  loggedIn,
  mockAuthEnabled,
}: {
  product: ProductDetail;
  loggedIn: boolean;
  mockAuthEnabled: boolean;
}) {
  // 单组规格、单选：默认选中第一项。种子保证至少一项，取不到时回落到商品自身价格。
  const [specId, setSpecId] = useState<string | null>(product.specs[0]?.id ?? null);
  const spec = product.specs.find((item) => item.id === specId) ?? null;
  const price = spec?.price ?? product.price;

  const offShelf = product.status === "off";
  const [pendingAction, setPendingAction] = useState<GatedAction | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const router = useRouter();

  function run(action: GatedAction) {
    if (action === "buy") {
      // 结算页只接收 ID：价格由服务端按 productId + specId 重算，地址里不出现任何金额
      const query = new URLSearchParams({ productId: product.id });
      if (specId) query.set("specId", specId);
      router.push(`/checkout?${query.toString()}`);
      return;
    }
    if (action === "favorite") {
      setNotice("已加入收藏（占位）。收藏列表属于 P6 内容。");
      return;
    }
    setNotice("客服会话属于 P6 内容，当前为占位反馈。");
  }

  function request(action: GatedAction) {
    if (!loggedIn) {
      setPendingAction(action);
      setSheetOpen(true);
      return;
    }
    run(action);
  }

  return (
    <>
      <section className="mt-2 bg-surface px-4 pb-4 pt-3.5">
        {/* 商品名称与价格是两个独立字段：标题中不含价格前缀 */}
        <h1 className="text-[19px] font-semibold leading-7 text-ink">{product.title}</h1>
        {product.subtitle ? (
          <p className="mt-1 text-[13px] leading-5 text-ink-3">{product.subtitle}</p>
        ) : null}

        <p className="mt-2 text-[13px] text-ink-3">月售 {abbreviateNumber(product.monthlySales)}</p>

        <div className="mt-3 flex items-center gap-2">
          <span className="shrink-0 rounded-[6px] bg-ink px-2 py-[3px] text-[12px] text-white">
            {product.gameTag}
          </span>
          {offShelf ? (
            <span className="shrink-0 rounded-[6px] bg-page px-2 py-[3px] text-[12px] text-ink-3">
              已下架
            </span>
          ) : null}
          <PriceText cents={price} className="ml-auto text-[24px] text-brand-red" />
        </div>

        {offShelf ? (
          <p className="mt-3 rounded-[8px] bg-page px-3 py-2 text-[12px] leading-5 text-ink-3">
            该商品已下架，暂不可购买。
          </p>
        ) : null}
      </section>

      {product.specs.length > 0 ? (
        <section className="mt-2 bg-surface px-4 py-4">
          <h2 className="text-[15px] font-semibold text-ink">属性</h2>

          <div className="mt-3 flex flex-wrap gap-2">
            {product.specs.map((item) => {
              const active = item.id === specId;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={offShelf}
                  aria-pressed={active}
                  onClick={() => setSpecId(item.id)}
                  className={`rounded-[8px] border px-3 py-2 text-left text-[13px] leading-[18px] disabled:opacity-50 ${
                    active
                      ? "border-brand-red bg-[#fff5f5] font-medium text-brand-red"
                      : "border-line text-ink-2"
                  }`}
                >
                  {item.name}
                  <span className="ml-2 text-[12px] text-ink-3">¥{formatYuan(item.price)}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {notice ? (
        <p className="mt-2 bg-surface px-4 pb-4 text-[13px] leading-5 text-ink-3">{notice}</p>
      ) : null}

      {/* 底部操作栏：sticky 且在文档流内，因此始终可见，正文也不会被它盖住 */}
      <div className="sticky bottom-0 z-20 mt-2 flex items-center gap-3 border-t border-line bg-surface px-3 py-2 pb-[max(8px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => request("service")}
          className="flex w-12 shrink-0 flex-col items-center gap-0.5 py-1 text-ink-2"
        >
          <HeadsetIcon />
          <span className="text-[11px]">客服</span>
        </button>

        <button
          type="button"
          onClick={() => request("favorite")}
          className="flex w-12 shrink-0 flex-col items-center gap-0.5 py-1 text-ink-2"
        >
          <StarIcon />
          <span className="text-[11px]">收藏</span>
        </button>

        <button
          type="button"
          disabled={offShelf}
          onClick={() => request("buy")}
          className="h-11 flex-1 rounded-full bg-brand-red text-[16px] font-medium text-white disabled:bg-line disabled:text-ink-3"
        >
          {offShelf ? "已下架" : "立即购买"}
        </button>
      </div>

      <LoginSheet
        open={sheetOpen}
        mockAuthEnabled={mockAuthEnabled}
        onClose={() => {
          setSheetOpen(false);
          setPendingAction(null);
        }}
        onSuccess={() => {
          setSheetOpen(false);
          if (pendingAction) run(pendingAction);
          setPendingAction(null);
        }}
      />
    </>
  );
}

function HeadsetIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <path d="M4 14h2.5v5H6a2 2 0 0 1-2-2z" />
      <path d="M20 14h-2.5v5H18a2 2 0 0 0 2-2z" />
      <path d="M20 19a3 3 0 0 1-3 3h-3" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 4l2.5 5.2 5.5.8-4 3.9.9 5.6-4.9-2.7-4.9 2.7.9-5.6-4-3.9 5.5-.8z" />
    </svg>
  );
}
