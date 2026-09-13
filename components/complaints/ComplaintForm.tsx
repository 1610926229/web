"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import EvidencePicker from "@/components/common/EvidencePicker";
import {
  COMPLAINT_CONTACT_MAX_LENGTH,
  COMPLAINT_DESCRIPTION_MAX_LENGTH,
  COMPLAINT_TYPES,
  COMPLAINT_TYPE_REQUIRED_MESSAGE,
  validateComplaintText,
} from "@/lib/constants/complaints";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import { submitComplaint } from "@/lib/services/complaintsHttp";

/** 可选关联订单：只带够列表展示的字段，页面不持有订单详情。 */
export type ComplaintOrderOption = {
  id: string;
  orderNo: string;
  productTitle: string;
  statusLabel: string;
};

/**
 * 提交投诉表单。
 *
 * 三条规则在这里体现为「用户看得见的行为」：
 *
 * 1. **只能关联自己的订单**：可选列表由服务端按当前用户查出来，页面不做任何过滤；
 *    就算有人手工往请求里塞别人的订单 id，接口也会返回 404。
 * 2. **不承诺处理结论**：页面只说明「已记录、客服会核实」，绝不出现免单 / 补偿 / 退款
 *    这类平台没有承诺过的话（文案在 `COMPLAINT_RESULT_PENDING_NOTE`，只有那一份）。
 * 3. **防重复提交**：`pending` 禁用按钮 + `submittingRef` 同步闸门 + 一次提交意图一个幂等键，
 *    失败重试沿用同一个键，服务端因此只会在记录里多出一条。
 *
 * 与退款表单一致的另一点：**失败不清空输入**，用户改一下就能重试。
 */
export default function ComplaintForm({
  orders,
  initialOrderId,
  orderNotice,
}: {
  orders: ComplaintOrderOption[];
  initialOrderId: string | null;
  /** 地址里带的订单不可用时的说明；为空表示没有这种情况 */
  orderNotice: string;
}) {
  const [orderId, setOrderId] = useState(initialOrderId ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [typeKey, setTypeKey] = useState("");
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState("");
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const submittingRef = useRef(false);
  /** 一次「提交意图」一个键；内容改动时清空，失败重试沿用（见 `RefundForm` 的同一处理）。 */
  const submitKeyRef = useRef<string | null>(null);

  const selectedOrder = orders.find((order) => order.id === orderId) ?? null;

  function invalidateSubmitKey() {
    submitKeyRef.current = null;
  }

  async function submit() {
    if (submittingRef.current) return;

    if (!typeKey) {
      setError(COMPLAINT_TYPE_REQUIRED_MESSAGE);
      return;
    }
    const text = validateComplaintText(description, contact);
    if (!text.ok) {
      setError(text.message);
      return;
    }

    submittingRef.current = true;
    setPending(true);
    setError("");

    submitKeyRef.current ??= crypto.randomUUID();

    try {
      const result = await submitComplaint({
        typeKey,
        description: text.description,
        contact: text.contact,
        evidence,
        orderId,
        idempotencyKey: submitKeyRef.current,
      });
      // 用 replace：提交完再回退不该回到一张已经提交过的表单
      router.replace(`/complaints/${result.complaintId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请稍后重试");
      submittingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-page pb-8">
      {/* 关联订单：选填。从订单详情进来时已经选好，这里可以更换或取消关联 */}
      <section className="bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-medium text-ink">关联订单（选填）</h2>
          <button
            type="button"
            disabled={pending}
            onClick={() => setPickerOpen((open) => !open)}
            className="text-[13px] text-brand-blue disabled:opacity-60"
          >
            {pickerOpen ? "收起" : selectedOrder ? "更换" : "选择订单"}
          </button>
        </div>

        {selectedOrder ? (
          <div className="mt-2 rounded-[8px] bg-page px-3 py-2">
            <p className="line-clamp-1 text-[13px] text-ink">{selectedOrder.productTitle}</p>
            <p className="mt-0.5 text-[12px] text-ink-3">
              订单号 {selectedOrder.orderNo} · {selectedOrder.statusLabel}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-[12px] leading-4 text-ink-3">
            不关联订单也可以提交，平台服务类问题可以直接描述。
          </p>
        )}

        {orderNotice ? (
          <p role="status" className="mt-1.5 text-[12px] leading-4 text-brand-red">
            {orderNotice}
          </p>
        ) : null}

        {pickerOpen ? (
          <ul className="mt-2 flex flex-col">
            <li>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  invalidateSubmitKey();
                  setOrderId("");
                  setPickerOpen(false);
                }}
                className="w-full border-b border-line py-2 text-left text-[13px] text-ink-2 disabled:opacity-60"
              >
                不关联订单
              </button>
            </li>
            {orders.map((order) => (
              <li key={order.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    invalidateSubmitKey();
                    setOrderId(order.id);
                    setPickerOpen(false);
                  }}
                  className="w-full border-b border-line py-2 text-left last:border-b-0 disabled:opacity-60"
                >
                  <span className="line-clamp-1 text-[13px] text-ink">{order.productTitle}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-3">
                    订单号 {order.orderNo} · {order.statusLabel}
                  </span>
                </button>
              </li>
            ))}
            {orders.length === 0 ? (
              <li className="py-2 text-[13px] text-ink-3">暂无可关联的订单</li>
            ) : null}
          </ul>
        ) : null}
      </section>

      {/* 投诉类型：必选 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">
          投诉类型 <span className="text-brand-red">*</span>
        </h2>
        <div className="mt-2 flex flex-col">
          {COMPLAINT_TYPES.map((type) => {
            const active = type.key === typeKey;
            return (
              <button
                key={type.key}
                type="button"
                disabled={pending}
                aria-pressed={active}
                onClick={() => {
                  invalidateSubmitKey();
                  setTypeKey(type.key);
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
                <span className={active ? "text-ink" : "text-ink-2"}>{type.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 问题描述：必填，长度受限 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-medium text-ink">
            问题描述 <span className="text-brand-red">*</span>
          </h2>
          <span className="text-[12px] text-ink-3">
            {description.length}/{COMPLAINT_DESCRIPTION_MAX_LENGTH}
          </span>
        </div>
        <textarea
          value={description}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setDescription(event.target.value);
          }}
          maxLength={COMPLAINT_DESCRIPTION_MAX_LENGTH}
          rows={4}
          placeholder="请描述遇到的问题、发生时间和你的诉求"
          aria-label="问题描述"
          className="mt-2 w-full resize-none rounded-[8px] bg-page px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
        />

        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <span className="shrink-0 text-[13px] text-ink-2">联系方式</span>
          <input
            value={contact}
            disabled={pending}
            onChange={(event) => {
              invalidateSubmitKey();
              setContact(event.target.value);
            }}
            maxLength={COMPLAINT_CONTACT_MAX_LENGTH}
            placeholder="选填，便于客服联系你"
            aria-label="联系方式"
            className="h-8 min-w-0 flex-1 bg-transparent text-right text-[13px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
          />
        </div>
        <p className="mt-1 text-[11px] leading-4 text-ink-3">
          联系方式最多 {COMPLAINT_CONTACT_MAX_LENGTH} 个字，本阶段不会采集更敏感的信息。
        </p>
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
          投诉只是把问题记录给客服，不会因此自动退款或改动订单状态，处理结果以客服反馈为准。
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
          {pending ? "提交中…" : "提交投诉"}
        </button>
      </div>
    </div>
  );
}
