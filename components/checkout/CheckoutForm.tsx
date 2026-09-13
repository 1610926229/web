"use client";

/* eslint-disable @next/next/no-img-element -- 商品封面为本地 SVG 占位图，不经 next/image 优化器。 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PriceText from "@/components/common/PriceText";
import {
  GAME_ACCOUNT_MAX_LENGTH,
  MAX_QUANTITY,
  REMARK_MAX_LENGTH,
  validateGameAccount,
} from "@/lib/constants/checkout";
import { createPaymentRequest, previewCheckout } from "@/lib/services/checkoutHttp";
import { formatYuan } from "@/lib/utils/format";
import CompanionSheet from "./CompanionSheet";
import QuantityStepper from "./QuantityStepper";
import type { Addon } from "@/lib/types/catalog";
import type { Companion } from "@/lib/types/companion";
import type { CheckoutPreview, CheckoutSelection } from "@/lib/types/payment";
import type { ProductSpec } from "@/lib/types/product";

/** 试算状态。`error` 与 `loading` 期间都不允许支付：手上的金额可能已不是当前选择的价格。 */
type PreviewStatus = "ready" | "loading" | "error";

/**
 * 确认订单表单。
 *
 * 关于金额，这个组件有三条必须守住的边界：
 *
 * 1. **不做金额运算**。展示的每一个金额都来自服务端试算结果，本地只负责原样显示；
 *    提交时也只发「用户选了什么」，不发任何价格字段（见 `CheckoutSelection` 类型）。
 * 2. **改规格 / 数量 / 增值服务后重新试算**。试算是异步的，用 `previewTicketRef` 计数：
 *    只有最后一次请求的结果会被采纳，先发后到的旧响应会被丢弃。
 * 3. **试算失败禁止支付**。失败时底部金额显示为「—」、按钮旁写明原因，并给出重试入口，
 *    避免用一个已经过期的价格把用户送进支付。
 * 4. **校验失败必须有看得见的反馈**。游戏 ID 为空 / 只有空格 / 格式不合法时，
 *    在输入框下方常驻显示错误（并滚动、聚焦到该输入框），而不是只在文档末尾留一句话——
 *    底部支付栏是吸附在视口底部的 sticky 元素，写在它上面的提示很容易落在屏幕之外，
 *    用户的感觉就是「点了没反应」。顶部提示只是增强，行内错误才是主渠道。
 *    游戏 ID 为空**不会**禁用按钮：点不动又不说原因，用户无从判断该改什么。
 *
 * 关于重复提交：点击「去支付」时为**这一次提交意图**生成一个幂等键，
 * 失败重试复用同一个键；服务端按「用户 + 幂等键」去重。按钮禁用只是顺手为之，
 * 真正防重的是这个键——网络重试、连点、刷新都绕不过它。
 *
 * 商品名称、封面、规格列表来自服务端页面 props（也是服务端读的数据），
 * 因此即便试算失败，页面结构依然完整，只有金额位置显示为未知。
 */
export default function CheckoutForm({
  product,
  specs,
  initialSpecId,
  regions,
  initialRegion,
  addons,
  companions,
  initialPreview,
  initialPreviewError,
}: {
  product: { id: string; title: string; subtitle: string; coverUrl: string };
  specs: ProductSpec[];
  initialSpecId: string;
  regions: string[];
  initialRegion: string;
  addons: Addon[];
  companions: Companion[];
  initialPreview: CheckoutPreview | null;
  initialPreviewError: string;
}) {
  const [specId, setSpecId] = useState(initialSpecId);
  const [quantity, setQuantity] = useState(1);
  const [region, setRegion] = useState(initialRegion);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [gameAccountId, setGameAccountId] = useState("");
  const [remark, setRemark] = useState("");
  const [companion, setCompanion] = useState<Companion | null>(null);
  const [companionOpen, setCompanionOpen] = useState(false);

  const [preview, setPreview] = useState<CheckoutPreview | null>(initialPreview);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>(
    initialPreview ? "ready" : "error",
  );
  const [previewError, setPreviewError] = useState(initialPreviewError);

  const [submitting, setSubmitting] = useState(false);
  /** 字段级错误：常驻显示在对应输入框下方，并驱动 `aria-invalid` / `aria-describedby` */
  const [fieldError, setFieldError] = useState<{ field: "gameAccountId"; message: string } | null>(
    null,
  );
  /** 表单级错误：与某个字段无关的失败（如提交失败） */
  const [formError, setFormError] = useState<string | null>(null);
  /** 顶部提示：只作增强，一闪而过，**不能作为唯一的错误反馈** */
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);

  const previewTicketRef = useRef(0);
  const idempotencyKeyRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const toastIdRef = useRef(0);
  const gameAccountRowRef = useRef<HTMLDivElement>(null);
  const gameAccountInputRef = useRef<HTMLInputElement>(null);

  const router = useRouter();

  // 顶部提示自动消失；重复点击同一条错误也会重新计时（id 每次都变）
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  function showToast(text: string) {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, text });
  }

  /**
   * 游戏 ID 校验失败时的统一反馈：常驻的行内错误 + 顶部提示 + 滚动并聚焦到输入框。
   *
   * 滚动放在下一帧执行：错误提示要先渲染出来，元素高度变了再去定位，才不会被顶偏。
   */
  function failGameAccount(message: string) {
    setFieldError({ field: "gameAccountId", message });
    setFormError(null);
    showToast(message);

    requestAnimationFrame(() => {
      gameAccountRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      // preventScroll：滚动交给上面的 scrollIntoView，聚焦不再二次抢滚动
      gameAccountInputRef.current?.focus({ preventScroll: true });
    });
  }

  const spec = specs.find((item) => item.id === specId) ?? specs[0];

  /** 当前表单对应的业务选择。金额不在这里，也不允许在这里。 */
  function currentSelection(overrides: Partial<CheckoutSelection> = {}): CheckoutSelection {
    return {
      productId: product.id,
      specId,
      quantity,
      region,
      addonIds,
      gameAccountId: gameAccountId.trim(),
      remark: remark.trim(),
      companionId: companion ? companion.id : null,
      ...overrides,
    };
  }

  async function refreshPreview(changes: Partial<CheckoutSelection>) {
    const ticket = ++previewTicketRef.current;
    setPreviewStatus("loading");
    setPreviewError("");

    try {
      const next = await previewCheckout(currentSelection(changes));
      if (ticket !== previewTicketRef.current) return; // 过期响应，丢弃
      setPreview(next);
      setPreviewStatus("ready");
    } catch (cause) {
      if (ticket !== previewTicketRef.current) return;
      setPreviewStatus("error");
      setPreviewError(cause instanceof Error ? cause.message : "金额试算失败，请重试");
    }
  }

  function selectSpec(nextId: string) {
    if (nextId === specId) return;
    setSpecId(nextId);
    void refreshPreview({ specId: nextId });
  }

  function selectQuantity(next: number) {
    if (next === quantity) return;
    setQuantity(next);
    void refreshPreview({ quantity: next });
  }

  function selectRegion(next: string) {
    if (next === region) return;
    setRegion(next);
    void refreshPreview({ region: next });
  }

  function toggleAddon(id: string) {
    const next = addonIds.includes(id) ? addonIds.filter((item) => item !== id) : [...addonIds, id];
    setAddonIds(next);
    void refreshPreview({ addonIds: next });
  }

  async function submit() {
    if (submittingRef.current) return;

    // 先校验字段：游戏 ID 为空 / 只有空格 / 格式不合法都在这里拦下，
    // 下面的创建支付请求**不会被执行**（校验失败直接 return）。
    const account = validateGameAccount(gameAccountId);
    if (!account.ok) {
      failGameAccount(account.message);
      return;
    }

    if (previewStatus !== "ready") {
      const message = "金额试算未完成，暂时无法支付，请先重试试算";
      setFormError(message);
      showToast(message);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);

    // 同一次提交意图复用同一个幂等键：失败重试不会多出第二条支付请求
    const key = idempotencyKeyRef.current ?? crypto.randomUUID();
    idempotencyKeyRef.current = key;

    try {
      const created = await createPaymentRequest({
        ...currentSelection({ gameAccountId: account.value }),
        idempotencyKey: key,
      });
      // 已经落库，下一次点击属于新的提交意图，换新键
      idempotencyKeyRef.current = null;
      router.push(`/pay/result?requestId=${encodeURIComponent(created.id)}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "提交失败，请重试";
      setFormError(message);
      showToast(message);
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /**
   * 按钮禁用**只**由这几件事决定，与游戏 ID 是否填写无关：
   * 正在提交、试算中、试算失败。游戏 ID 的问题在点击时以表单校验的形式反馈，
   * 不能靠一个点不动的按钮让用户猜原因。
   */
  const payDisabled = submitting || previewStatus !== "ready";

  const disabledReason = submitting
    ? "正在提交，请稍候…"
    : previewStatus === "loading"
      ? "正在按当前选择试算金额，试算完成后即可支付"
      : previewStatus === "error"
        ? "金额试算失败，暂时无法支付，请先点上方「重试」"
        : null;

  return (
    <>
      {/* —— 商品与数量 —— */}
      <section className="mt-2 bg-surface px-4 py-3.5">
        <div className="flex gap-3">
          <img
            src={product.coverUrl}
            alt=""
            className="h-[80px] w-[80px] shrink-0 rounded-[8px] border border-line bg-page object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="line-clamp-2 text-[15px] font-medium leading-5 text-ink">
              {product.title}
            </h2>
            {product.subtitle ? (
              <p className="mt-1 line-clamp-1 text-[12px] text-ink-3">{product.subtitle}</p>
            ) : null}
            <div className="mt-auto flex items-end justify-between">
              <PriceText cents={spec.price} className="text-[18px] text-brand-red" />
              <QuantityStepper
                value={quantity}
                max={MAX_QUANTITY}
                disabled={submitting}
                onChange={selectQuantity}
              />
            </div>
          </div>
        </div>
      </section>

      {/* —— 下单信息 —— */}
      <section className="mt-2 bg-surface px-4 py-4">
        <h2 className="text-[15px] font-semibold text-ink">服务信息</h2>

        <Row label="大区选择">
          <div className="flex flex-wrap justify-end gap-2">
            {regions.map((item) => (
              <Chip
                key={item}
                active={item === region}
                disabled={submitting}
                onClick={() => selectRegion(item)}
              >
                {item}
              </Chip>
            ))}
          </div>
        </Row>

        <Row label="商品规格">
          <div className="flex flex-wrap justify-end gap-2">
            {specs.map((item) => (
              <Chip
                key={item.id}
                active={item.id === specId}
                disabled={submitting}
                onClick={() => selectSpec(item.id)}
              >
                {item.name} ¥{formatYuan(item.price)}
              </Chip>
            ))}
          </div>
        </Row>

        {/* 滚动定位的目标是整个「游戏 ID」区域，而不只是输入框本身 */}
        <div ref={gameAccountRowRef}>
          <Row label="游戏 ID" required>
            <input
              id="game-account-id"
              ref={gameAccountInputRef}
              value={gameAccountId}
              onChange={(event) => {
                setGameAccountId(event.target.value);
                // 用户开始修改就清掉旧提示；若新内容仍不合法，提交时会再次提示
                if (fieldError) setFieldError(null);
              }}
              maxLength={GAME_ACCOUNT_MAX_LENGTH}
              disabled={submitting}
              placeholder="请输入游戏内 ID"
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? "game-account-id-error" : undefined}
              className={`h-9 w-full rounded-[8px] border bg-page px-3 text-right text-[14px] text-ink outline-none placeholder:text-ink-3 ${
                fieldError ? "border-brand-red" : "border-line"
              }`}
            />
          </Row>

          {fieldError ? (
            <p
              id="game-account-id-error"
              role="alert"
              className="mt-1 text-right text-[12px] leading-4 text-brand-red"
            >
              {fieldError.message}
            </p>
          ) : null}
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[14px] text-ink-2">增值服务</span>
            <span className="text-[11px] text-ink-3">Mock 选项，非最终业务规则</span>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            {addons.map((addon) => (
              <Chip
                key={addon.id}
                active={addonIds.includes(addon.id)}
                disabled={submitting}
                onClick={() => toggleAddon(addon.id)}
              >
                {addon.name} +¥{formatYuan(addon.price)}
              </Chip>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-4 text-ink-3">
            增值服务按整单计费，不随购买数量变化。
          </p>
        </div>
      </section>

      {/* —— 陪玩 —— */}
      <section className="mt-2 bg-surface px-4 py-4">
        <button
          type="button"
          disabled={submitting}
          onClick={() => setCompanionOpen(true)}
          className="flex w-full items-center gap-3 rounded-[10px] bg-[#f3f0fb] px-3 py-3 text-left"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-[15px]">
            🔔
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">推荐陪玩</span>
            <span className="block truncate text-[12px] text-ink-3">
              {companion
                ? `${companion.displayName} · ${companion.rankLabel}`
                : "未选择，可由平台后续接单或分配"}
            </span>
          </span>
          <span className="shrink-0 text-[13px] text-ink-3">{companion ? "更换" : "去选择"} ›</span>
        </button>

        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          选择陪玩只是指定意向，不代表对方已接单。不选择也可以直接支付。
        </p>
      </section>

      {/* —— 备注 —— */}
      <section className="mt-2 bg-surface px-4 py-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px] text-ink-2">订单备注</span>
          <span className="text-[11px] text-ink-3">选填</span>
        </div>
        <textarea
          value={remark}
          onChange={(event) => setRemark(event.target.value)}
          maxLength={REMARK_MAX_LENGTH}
          disabled={submitting}
          rows={3}
          placeholder="补充要求、期望时间等"
          className="mt-2 w-full resize-none rounded-[8px] border border-line bg-page px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3"
        />
        <p className="mt-1 text-right text-[11px] text-ink-3">
          {remark.length}/{REMARK_MAX_LENGTH}
        </p>
      </section>

      {/* —— 金额 —— */}
      <section className="mt-2 bg-surface px-4 py-4">
        <h2 className="text-[15px] font-semibold text-ink">费用明细</h2>

        <Row label="商品金额">
          <span className="text-[14px] text-ink">
            {preview ? `¥${formatYuan(preview.itemsAmount)}` : "—"}
            <span className="ml-1 text-[12px] text-ink-3">
              （¥{formatYuan(spec.price)} × {quantity}）
            </span>
          </span>
        </Row>

        <Row label="增值服务">
          <span className="text-[14px] text-ink">
            {preview ? `¥${formatYuan(preview.addonsAmount)}` : "—"}
          </span>
        </Row>

        <Row label="应付金额">
          {preview ? (
            <PriceText cents={preview.totalAmount} className="text-[17px] text-brand-red" />
          ) : (
            <span className="text-[17px] font-semibold text-ink-3">—</span>
          )}
        </Row>

        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          金额由服务端试算得出，支付时服务端会再校验并重算一次。
        </p>

        {previewStatus === "loading" ? (
          <p className="mt-2 rounded-[8px] bg-page px-3 py-2 text-[12px] text-ink-3">
            正在按当前选择重新试算金额…
          </p>
        ) : null}

        {previewStatus === "error" ? (
          <div className="mt-2 flex items-center gap-3 rounded-[8px] bg-page px-3 py-2">
            <span className="flex-1 text-[12px] leading-4 text-brand-red">
              {previewError || "金额试算失败"}
            </span>
            <button
              type="button"
              onClick={() => void refreshPreview({})}
              className="shrink-0 rounded-full border border-brand-red px-3 py-1 text-[12px] text-brand-red"
            >
              重试
            </button>
          </div>
        ) : null}
      </section>

      {/* 底部支付栏：sticky 且在文档流内，正文不会被它盖住 */}
      <div className="sticky bottom-0 z-20 mt-2 border-t border-line bg-surface px-4 py-2.5 pb-[max(10px,env(safe-area-inset-bottom))]">
        {/* 表单级错误与按钮禁用原因都紧贴按钮上方：用户点按钮时视线就在这里，
            放在文档末尾的提示会被吸附在底部的这条栏盖住或落在屏幕之外 */}
        {formError ? (
          <p role="alert" className="mb-2 text-[12px] leading-4 text-brand-red">
            {formError}
          </p>
        ) : null}

        {disabledReason ? (
          <p className="mb-2 text-[12px] leading-4 text-ink-3">{disabledReason}</p>
        ) : null}

        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-baseline">
            <span className="text-[12px] text-ink-3">实付金额</span>
            {preview ? (
              <PriceText cents={preview.totalAmount} className="ml-2 text-[20px] text-brand-red" />
            ) : (
              <span className="ml-2 text-[20px] font-semibold text-ink-3">—</span>
            )}
          </div>

          <button
            type="button"
            disabled={payDisabled}
            onClick={() => void submit()}
            className="h-11 shrink-0 rounded-full bg-brand-red px-8 text-[16px] font-medium text-white disabled:bg-line disabled:text-ink-3"
          >
            {submitting ? "提交中…" : previewStatus === "loading" ? "试算中…" : "去支付"}
          </button>
        </div>
      </div>

      {/* 顶部提示：一闪而过的增强反馈，行内错误仍然常驻 */}
      {toast ? (
        <div
          aria-hidden
          className="pointer-events-none fixed bottom-[92px] left-1/2 z-40 max-w-[80%] -translate-x-1/2 rounded-full bg-ink/85 px-4 py-2 text-[13px] leading-5 text-white"
        >
          {toast.text}
        </div>
      ) : null}

      <CompanionSheet
        open={companionOpen}
        companions={companions}
        selectedId={companion ? companion.id : null}
        onSelect={(next) => {
          setCompanion(next);
          setCompanionOpen(false);
        }}
        onClose={() => setCompanionOpen(false)}
      />
    </>
  );
}

/** 一行「标签 + 值」，值右对齐。 */
function Row({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-center gap-3">
      <span className="shrink-0 text-[14px] text-ink-2">
        {required ? <span className="mr-0.5 text-brand-red">*</span> : null}
        {label}
      </span>
      <div className="min-w-0 flex-1 text-right">{children}</div>
    </div>
  );
}

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-[8px] border px-3 py-1.5 text-[13px] disabled:opacity-50 ${
        active ? "border-brand-red bg-[#fff5f5] font-medium text-brand-red" : "border-line text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}
