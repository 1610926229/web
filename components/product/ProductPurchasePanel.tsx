"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PriceText from "@/components/common/PriceText";
import LoginSheet from "@/components/auth/LoginSheet";
import { FAVORITE_FAILED_MESSAGE } from "@/lib/constants/favorites";
import { addFavorite, removeFavorite } from "@/lib/services/favoritesHttp";
import { abbreviateNumber, formatYuan } from "@/lib/utils/format";
import type { ProductDetail } from "@/lib/types/product";

/** 需要登录的操作。游客点击时统一走登录流程，不在本组件里另写一套判断。 */
type GatedAction = "service" | "favorite" | "buy";

/**
 * 商品详情的商品信息、规格选择与底部操作栏。
 *
 * 客户端组件的原因有二：规格选择与收藏状态需要即时响应；受限操作要弹登录浮层。
 * 首屏内容（标题、月售、价格、规格、收藏状态）依然由它 SSR 输出，
 * 不会因为标记了 "use client" 就变空。
 *
 * `loggedIn` 与 `initialFavorited` 都由服务端读取后传入——是否登录、有没有收藏
 * 只由服务端说了算，客户端不自行判断，也不从 localStorage 取信。
 *
 * 登录后的继续操作：游客点「收藏」时先把动作记在 `pendingAction` 里并弹登录浮层，
 * 登录成功（`onSuccess`）后**自动接着执行收藏**，不要求用户再点一次。
 */
export default function ProductPurchasePanel({
  product,
  loggedIn,
  initialFavorited,
  mockAuthEnabled,
}: {
  product: ProductDetail;
  loggedIn: boolean;
  initialFavorited: boolean;
  mockAuthEnabled: boolean;
}) {
  // 单组规格、单选：默认选中第一项。种子保证至少一项，取不到时回落到商品自身价格。
  const [specId, setSpecId] = useState<string | null>(product.specs[0]?.id ?? null);
  const spec = product.specs.find((item) => item.id === specId) ?? null;
  const price = spec?.price ?? product.price;

  const offShelf = product.status === "off";
  const [pendingAction, setPendingAction] = useState<GatedAction | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [favorited, setFavorited] = useState(initialFavorited);
  const [favoritePending, setFavoritePending] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  /** 同步闸门：state 更新是异步的，连点两次可能都在重渲染之前到达 */
  const favoriteRunningRef = useRef(false);

  /** 已下架且尚未收藏：不能再新增收藏（服务端同样会拒绝）。已收藏的仍可取消。 */
  const favoriteDisabled = offShelf && !favorited;

  const router = useRouter();

  /**
   * 切换收藏状态。
   *
   * 结果以**服务端返回的最终状态**为准（不是本地取反），因此重复请求不会让按钮显示错误状态：
   * 收藏同一商品是幂等的，取消收藏重复请求也安全。
   */
  async function toggleFavorite() {
    if (favoriteRunningRef.current) return;
    favoriteRunningRef.current = true;
    setFavoritePending(true);
    setFavoriteError(null);

    try {
      const result = favorited
        ? await removeFavorite(product.id)
        : await addFavorite(product.id);
      setFavorited(result.favorited);
    } catch (cause) {
      // 失败时保持原状态，并说明原因（如商品已下架不能新增收藏）
      setFavoriteError(cause instanceof Error ? cause.message : FAVORITE_FAILED_MESSAGE);
    } finally {
      favoriteRunningRef.current = false;
      setFavoritePending(false);
    }
  }

  function run(action: GatedAction) {
    if (action === "buy") {
      // 结算页只接收 ID：价格由服务端按 productId + specId 重算，地址里不出现任何金额
      const query = new URLSearchParams({ productId: product.id });
      if (specId) query.set("specId", specId);
      router.push(`/checkout?${query.toString()}`);
      return;
    }
    if (action === "favorite") {
      void toggleFavorite();
      return;
    }
    // 客服是已实现的模块，直接进客服页，不再走占位提示
    router.push("/service");
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
            {favorited
              ? "该商品已下架，暂不可购买；已收藏的记录仍可保留或取消。"
              : "该商品已下架，暂不可购买与收藏。"}
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

      {favoriteError ? (
        <p role="alert" className="mt-2 bg-surface px-4 pb-4 text-[13px] leading-5 text-brand-red">
          {favoriteError}
        </p>
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

        {/*
          已下架且尚未收藏：按钮置灰并给出无障碍名称说明原因。
          下架商品不能被新增收藏，因此这里不放进登录流程——点了必然失败，不如直接说明。
          已收藏的下架商品仍可点（取消收藏是安全的）。
        */}
        <button
          type="button"
          disabled={favoriteDisabled || favoritePending}
          onClick={() => request("favorite")}
          aria-label={
            favoriteDisabled ? "商品已下架，暂不能收藏" : favorited ? "取消收藏" : "收藏"
          }
          className={`flex w-12 shrink-0 flex-col items-center gap-0.5 py-1 disabled:opacity-50 ${
            favorited ? "text-brand-red" : "text-ink-2"
          }`}
        >
          <StarIcon filled={favorited} />
          <span className="text-[11px]">{favorited ? "已收藏" : "收藏"}</span>
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

/** 收藏图标。已收藏时填色——形状不再是唯一的区分手段，色盲用户同样能分辨。 */
function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill={filled ? "currentColor" : "none"}
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
