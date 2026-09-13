"use client";

/* eslint-disable @next/next/no-img-element -- 商品封面为 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import EvidencePicker from "@/components/common/EvidencePicker";
import PriceText from "@/components/common/PriceText";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import {
  REFUND_AMOUNT_NOTE,
  REFUND_DESCRIPTION_EMPTY_MESSAGE,
  REFUND_DESCRIPTION_MAX_LENGTH,
  REFUND_DESCRIPTION_TOO_LONG_MESSAGE,
  REFUND_REASON_REQUIRED_MESSAGE,
  REFUND_REASONS,
} from "@/lib/constants/refunds";
import { submitRefund } from "@/lib/services/refundsHttp";

/**
 * 退款申请表单。
 *
 * 三条规则在这里体现为「用户看得见的行为」：
 *
 * 1. **金额不可编辑**：只展示订单实付金额，没有任何输入框——金额是服务端按整单算的，
 *    表单里连字段都没有，用户改不了也填不了。
 * 2. **防重复提交**：`pending` 时按钮禁用（视觉），`submittingRef` 是同步闸门（真正生效的
 *    那道，state 更新是异步的，连点两次可能都读到旧值）。另外每次「一次提交意图」都带同一个
 *    幂等键，失败重试沿用同一个键，服务端因此只会产生一条申请。
 * 3. **失败不清空输入**：出错时原因、说明、凭证全部保留，用户改一下就能重试。
 */
export default function RefundForm({
  orderId,
  orderNo,
  productTitle,
  productCoverUrl,
  specName,
  quantity,
  amount,
}: {
  orderId: string;
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  /** 单位：分。整单退款，由服务端按订单实付金额给出 */
  amount: number;
}) {
  const [reasonKey, setReasonKey] = useState("");
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const submittingRef = useRef(false);
  /**
   * 幂等键：一次「提交意图」一个键。
   *
   * 内容被改动时清空——改了内容就是另一次意图，沿用旧键会让服务端返回上一次的结果，
   * 用户会看到「提交成功但内容还是旧的」。提交失败则保留同一个键，
   * 于是重试不会产生第二条申请。
   */
  const submitKeyRef = useRef<string | null>(null);

  function invalidateSubmitKey() {
    submitKeyRef.current = null;
  }

  async function submit() {
    if (submittingRef.current) return;

    const trimmed = description.trim();
    if (!reasonKey) {
      setError(REFUND_REASON_REQUIRED_MESSAGE);
      return;
    }
    if (!trimmed) {
      setError(REFUND_DESCRIPTION_EMPTY_MESSAGE);
      return;
    }
    if (trimmed.length > REFUND_DESCRIPTION_MAX_LENGTH) {
      setError(REFUND_DESCRIPTION_TOO_LONG_MESSAGE);
      return;
    }

    submittingRef.current = true;
    setPending(true);
    setError("");

    // 同一份内容重试时复用同一个键；首次提交或内容改动过则生成新的
    submitKeyRef.current ??= crypto.randomUUID();

    try {
      const result = await submitRefund(orderId, {
        reasonKey,
        description: trimmed,
        evidence,
        idempotencyKey: submitKeyRef.current,
      });
      // 用 replace：提交完再回退不该回到一张已经提交过的表单
      router.replace(`/refunds/${result.refundId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请稍后重试");
      submittingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-page pb-8">
      {/* 关联订单：让用户在提交前再确认一次退的是哪一单 */}
      <section className="bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">关联订单</h2>
        <div className="mt-2 flex gap-3">
          <img
            src={productCoverUrl}
            alt={productTitle}
            className="h-16 w-16 shrink-0 rounded-[8px] border border-line object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">{productTitle}</p>
            <p className="mt-1 truncate text-[12px] text-ink-3">{specName}</p>
            <p className="mt-auto pt-1 text-[12px] text-ink-3">
              订单号 {orderNo} · 数量 ×{quantity}
            </p>
          </div>
        </div>
      </section>

      {/* 退款金额：只读展示，整单退款 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-ink">退款金额</span>
          <PriceText cents={amount} className="text-[18px] text-brand-red" />
        </div>
        <p className="mt-1.5 text-[12px] leading-4 text-ink-3">{REFUND_AMOUNT_NOTE}</p>
      </section>

      {/* 退款原因：必选 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">
          退款原因 <span className="text-brand-red">*</span>
        </h2>
        <div className="mt-2 flex flex-col">
          {REFUND_REASONS.map((reason) => {
            const active = reason.key === reasonKey;
            return (
              <button
                key={reason.key}
                type="button"
                disabled={pending}
                aria-pressed={active}
                onClick={() => {
                  invalidateSubmitKey();
                  setReasonKey(reason.key);
                  setError("");
                }}
                className="flex items-center gap-2.5 border-b border-line py-2.5 text-left text-[14px] last:border-b-0 disabled:opacity-60"
              >
                <span
                  aria-hidden
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    active ? "border-brand-red" : "border-line"
                  }`}
                >
                  {active ? <span className="h-2 w-2 rounded-full bg-brand-red" /> : null}
                </span>
                <span className={active ? "text-ink" : "text-ink-2"}>{reason.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 退款说明：必填，长度受限 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-medium text-ink">
            退款说明 <span className="text-brand-red">*</span>
          </h2>
          <span className="text-[12px] text-ink-3">
            {description.length}/{REFUND_DESCRIPTION_MAX_LENGTH}
          </span>
        </div>
        <textarea
          value={description}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setDescription(event.target.value);
          }}
          maxLength={REFUND_DESCRIPTION_MAX_LENGTH}
          rows={4}
          placeholder="请说明具体情况，便于客服核实"
          aria-label="退款说明"
          className="mt-2 w-full resize-none rounded-[8px] bg-page px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
        />
      </section>

      <section className="mt-2 bg-surface px-4 py-3">
        <EvidencePicker
          value={evidence}
          disabled={pending}
          onChange={(next) => {
            invalidateSubmitKey();
            setEvidence(next);
          }}
        />
      </section>

      <div className="mt-2 px-4">
        <p className="text-[12px] leading-4 text-ink-3">
          提交后订单保持当前进度，退款申请会交给客服审核；审核期间可以在退款详情里查看进度。
        </p>

        {error ? (
          <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="mt-3 h-11 w-full rounded-full bg-brand-red text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "提交中…" : "提交退款申请"}
        </button>
      </div>
    </div>
  );
}
