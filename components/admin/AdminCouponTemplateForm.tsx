"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { AdminField, AdminToggleButton } from "@/components/admin/AdminFormField";
import {
  ADMIN_COUPON_ACTION_LABELS,
  ADMIN_COUPON_COMPUTABLE_NOTICE,
  ADMIN_COUPON_CONFIRM_TEXTS,
  ADMIN_COUPON_EDIT_TITLE,
  ADMIN_COUPON_FIELD_LABELS,
  ADMIN_COUPON_NAME_MAX_LENGTH,
  ADMIN_COUPON_NAME_TOO_LONG_MESSAGE,
  ADMIN_COUPON_NEW_TITLE,
  couponTemplateDraftFromForm,
  couponTemplateFieldErrors,
  couponTemplateFormFromPatch,
  firstCouponTemplateErrorField,
  hasCouponTemplateError,
  normalizeCouponTemplatePatch,
  type CouponTemplateField,
  type CouponTemplateFieldErrors,
  type CouponTemplateFormInput,
} from "@/lib/constants/adminCoupons";
import { createCouponTemplate, saveCouponTemplateProfile } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";
import type { AdminCouponTemplateItem, AdminCouponTemplateWriteResult } from "@/lib/types/coupon";

/**
 * 优惠券模板表单 —— 新建与编辑共用一份。
 *
 * 能改的字段就是下面五个：名称、满减门槛、优惠金额、有效期、启用状态。
 * `id`、`createdAt`、`updatedAt`、`formKey`、`valueLabel`、`conditionLabel`
 * **在界面上没有输入框、在接口入参里也没有位置**（§1 / §3 / §九）：
 * 一次普通保存永远无法把一张满减券改成折扣券，也永远无法伪造券面文案与时间。
 *
 * 三条与其它管理端表单一致的做法：
 *
 * 1. **不用 HTML `maxLength` 静默截断**：可以一直输入，字数实时显示、超限变红，
 *    由校验给出明确错误。截断会让人以为「我已经写完了」。
 * 2. **错误贴在字段旁边**（`aria-invalid` + `aria-describedby` + `role="alert"`），
 *    并把**第一条**出错的字段聚焦过去——顺序与服务端的校验顺序一致。
 * 3. **校验与服务端共用同一份函数**（`couponTemplateFieldErrors()` /
 *    `normalizeCouponTemplatePatch()`），因此不会出现「前端说能提交、服务端却拒绝」。
 *
 * ⚠️ **金额与时间在这里是文本**（元文本 / `datetime-local` 取值），
 * 换算是 `couponTemplateDraftFromForm()` 做的，两处都不自己实现第二套：
 * 表单里出现一次 `Number(x) * 100`，就等于给「0.1 + 0.2」留了一个入口。
 *
 * ⚠️ **服务端只拒绝、不夹取**（§4）：这里也不夹。输入「-1」得到的是
 * 一句「满减门槛必须大于 0」，而不是一个被悄悄改成 1 的门槛——
 * 后者会让一次写错的保存看起来成功。
 */
export default function AdminCouponTemplateForm({
  record,
  message,
  onSaved,
}: {
  /**
   * 编辑时的原始记录；**新建时显式传 `null`**。
   *
   * 用「有没有记录」代替一个额外的 `mode` 字段：两个 prop 表达同一件事，
   * 就有它们互相矛盾的可能，而那种矛盾只会在运行时暴露。
   */
  record: AdminCouponTemplateItem | null;
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (result: AdminCouponTemplateWriteResult, message: string) => void;
}) {
  const isCreate = record === null;

  const [form, setForm] = useState<CouponTemplateFormInput>(() =>
    record
      ? couponTemplateFormFromPatch(record)
      : {
          name: "",
          thresholdYuan: "",
          discountYuan: "",
          validFromLocal: "",
          validToLocal: "",
          enabled: true,
        },
  );

  const [errors, setErrors] = useState<CouponTemplateFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  /**
   * 把焦点移到出错的字段上（§十一：第一条错误自动聚焦）。
   *
   * ⚠️ 这里**不**用「每个字段一个 ref 回调、渲染期往 map 里写」的写法：
   * 那等于在渲染期改 ref，React 明确不允许。改成一次 DOM 查询——
   * 表单里每个字段都带 `data-coupon-field`；`role="radiogroup"` 的容器
   * 还要 `tabIndex={-1}` 才真的接得住焦点（div 默认不可聚焦）。
   */
  function focusField(field: CouponTemplateField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-coupon-field="${field}"]`)?.focus();
  }

  function update<K extends keyof CouponTemplateFormInput>(
    key: K,
    value: CouponTemplateFormInput[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const nameCount = countCharacters(form.name.trim());

  async function save(key: string) {
    const patch = normalizeCouponTemplatePatch(couponTemplateDraftFromForm(form));
    if (!patch) {
      // 正常路径上不会到这里：提交前已经校验过。留一条兜底，避免把未校验的数据发出去
      setSubmitError("表单校验未通过，请检查标红的字段");
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      const result =
        record === null
          ? await createCouponTemplate(key, patch)
          : await saveCouponTemplateProfile(record.id, key, patch);

      keyRef.current = null;
      setConfirming(false);

      if (record === null) {
        onSaved(result, "已创建，用户端领券中心立即生效");
        return;
      }
      onSaved(result, result.changed ? "已保存，改动只影响此后的领取与发放" : "没有需要保存的改动");
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "保存失败，请稍后重试。";
      // 确认框开着时错误显示在框里，否则显示在表单底部
      if (confirming) setConfirmError(text);
      else setSubmitError(text);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const next = couponTemplateFieldErrors(couponTemplateDraftFromForm(form));
    setErrors(next);
    setSubmitError(null);

    if (hasCouponTemplateError(next)) {
      // 第一条出错的字段：错误顺序与服务端的校验顺序一致，因此「最靠上的那条」就是它
      focusField(firstCouponTemplateErrorField(next));
      return;
    }

    // ⚠️ 只在没有键时生成，**不要**每次提交都换新的：请求已经发出去、响应丢了、
    // 用户再点一次保存时，必须复用的是**同一个**幂等键，服务端才认得出这是重试。
    // 每次都换键等于把「重试」变成「第二次新建」，会建出第二张券。
    // 键在保存成功（`save()`）与取消确认框时清空，因此下一次真实编辑仍会拿到新键。
    if (keyRef.current === null) keyRef.current = crypto.randomUUID();

    // 新建时「启用」是默认值，不是一个变更；只有编辑时改了启用状态才需要二次确认
    if (record !== null && form.enabled !== record.enabled) {
      setConfirmError(null);
      setConfirming(true);
      return;
    }

    void save(keyRef.current);
  }

  /** 字段级的公共属性：错误 → `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: CouponTemplateField) {
    const error = errors?.[field] ?? null;
    return {
      id: `coupon-${field}`,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? `coupon-${field}-error` : undefined,
      className: `h-9 w-full rounded-lg border px-3 text-[13px] text-ink outline-none ${
        error ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
      }`,
      message: error,
    };
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-xl border border-admin-line bg-surface p-4"
    >
      <div>
        <h2 className="text-[15px] font-medium text-ink">
          {isCreate ? ADMIN_COUPON_NEW_TITLE : ADMIN_COUPON_EDIT_TITLE}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          {isCreate
            ? "只能新建满减券；保存后立即出现在用户端领券中心（启用状态下）。"
            : "改动只影响此后的领取与发放：已经发出去或领到手的券沿用领取那一刻的券面快照，不会被追溯。"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 优惠券名称 */}
        <AdminField
          label={ADMIN_COUPON_FIELD_LABELS.name}
          error={fieldProps("name").message}
          errorId="coupon-name-error"
          counter={<AdminCharacterCounter current={nameCount} max={ADMIN_COUPON_NAME_MAX_LENGTH} />}
          htmlFor="coupon-name"
        >
          <input
            id="coupon-name"
            data-coupon-field="name"
            value={form.name}
            onChange={(event) => {
              const value = event.target.value;
              update("name", value);
              // 边写边说：超限立刻标红
              if (countCharacters(value.trim()) > ADMIN_COUPON_NAME_MAX_LENGTH) {
                setErrors((current) =>
                  current ? { ...current, name: ADMIN_COUPON_NAME_TOO_LONG_MESSAGE } : current,
                );
              }
            }}
            aria-invalid={fieldProps("name")["aria-invalid"]}
            aria-describedby={fieldProps("name")["aria-describedby"]}
            className={fieldProps("name").className}
          />
        </AdminField>

        {/* 启用状态 */}
        <AdminField
          label={ADMIN_COUPON_FIELD_LABELS.enabled}
          hint="停用后不能再被领取或发放，已发出的券也无法核销；券本身不会被删除"
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-coupon-field="enabled"
            aria-label={ADMIN_COUPON_FIELD_LABELS.enabled}
            className="flex gap-2"
          >
            <AdminToggleButton
              active={form.enabled}
              onClick={() => update("enabled", true)}
              label="启用"
            />
            <AdminToggleButton
              active={!form.enabled}
              onClick={() => update("enabled", false)}
              label="停用"
            />
          </div>
        </AdminField>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 满减门槛 */}
        <AdminField
          label={ADMIN_COUPON_FIELD_LABELS.thresholdAmount}
          error={fieldProps("thresholdAmount").message}
          errorId="coupon-thresholdAmount-error"
          hint="订单金额达到这个数额才可用；填元，最多两位小数"
          htmlFor="coupon-thresholdAmount"
        >
          <input
            id="coupon-thresholdAmount"
            data-coupon-field="thresholdAmount"
            value={form.thresholdYuan}
            inputMode="decimal"
            onChange={(event) => update("thresholdYuan", event.target.value)}
            aria-invalid={fieldProps("thresholdAmount")["aria-invalid"]}
            aria-describedby={fieldProps("thresholdAmount")["aria-describedby"]}
            className={fieldProps("thresholdAmount").className}
          />
        </AdminField>

        {/* 优惠金额 */}
        <AdminField
          label={ADMIN_COUPON_FIELD_LABELS.discountAmount}
          error={fieldProps("discountAmount").message}
          errorId="coupon-discountAmount-error"
          hint="结算时抵扣的金额，不能大于满减门槛；填元，最多两位小数"
          htmlFor="coupon-discountAmount"
        >
          <input
            id="coupon-discountAmount"
            data-coupon-field="discountAmount"
            value={form.discountYuan}
            inputMode="decimal"
            onChange={(event) => update("discountYuan", event.target.value)}
            aria-invalid={fieldProps("discountAmount")["aria-invalid"]}
            aria-describedby={fieldProps("discountAmount")["aria-describedby"]}
            className={fieldProps("discountAmount").className}
          />
        </AdminField>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 有效期开始 */}
        <AdminField
          label={ADMIN_COUPON_FIELD_LABELS.validFrom}
          error={fieldProps("validFrom").message}
          errorId="coupon-validFrom-error"
          hint="按北京时间填写"
          htmlFor="coupon-validFrom"
        >
          <input
            id="coupon-validFrom"
            data-coupon-field="validFrom"
            type="datetime-local"
            // 精确到秒：种子券的截止时刻是 23:59:59，截断到分会把「没改」
            // 变成一次真实的改动（见 `toDateTimeLocalValue` 上的说明）
            step="1"
            value={form.validFromLocal}
            onChange={(event) => update("validFromLocal", event.target.value)}
            aria-invalid={fieldProps("validFrom")["aria-invalid"]}
            aria-describedby={fieldProps("validFrom")["aria-describedby"]}
            className={fieldProps("validFrom").className}
          />
        </AdminField>

        {/* 有效期结束 */}
        <AdminField
          label={ADMIN_COUPON_FIELD_LABELS.validTo}
          error={fieldProps("validTo").message}
          errorId="coupon-validTo-error"
          hint="必须晚于开始时间；按北京时间填写"
          htmlFor="coupon-validTo"
        >
          <input
            id="coupon-validTo"
            data-coupon-field="validTo"
            type="datetime-local"
            step="1"
            value={form.validToLocal}
            onChange={(event) => update("validToLocal", event.target.value)}
            aria-invalid={fieldProps("validTo")["aria-invalid"]}
            aria-describedby={fieldProps("validTo")["aria-describedby"]}
            className={fieldProps("validTo").className}
          />
        </AdminField>
      </div>

      <p className="text-[12px] leading-4 text-ink-3">
        券面上的「满 X 减 Y」与使用条件由这两个金额**派生**，不单独编辑——
        它们是展示文案，不是业务真值。{ADMIN_COUPON_COMPUTABLE_NOTICE}
      </p>

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy
            ? "保存中…"
            : isCreate
              ? ADMIN_COUPON_ACTION_LABELS.create
              : ADMIN_COUPON_ACTION_LABELS.save}
        </button>
        <span className="text-[12px] leading-4 text-ink-3">
          本轮不提供删除：券的生命周期止于「停用」，历史领取与订单都还要指着它。
        </span>
      </div>

      {message ? (
        <p role="status" className="text-[13px] leading-5 text-status-success">
          {message}
        </p>
      ) : null}

      {submitError ? (
        <p role="alert" className="text-[13px] leading-5 text-brand-red">
          {submitError}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={confirming}
        title={`${form.enabled ? "启用" : "停用"}这张优惠券`}
        description={
          form.enabled ? ADMIN_COUPON_CONFIRM_TEXTS.enable : ADMIN_COUPON_CONFIRM_TEXTS.disable
        }
        confirmLabel={`确认${form.enabled ? "启用" : "停用"}`}
        tone={form.enabled ? "primary" : "danger"}
        pending={busy}
        error={confirmError}
        onConfirm={() => {
          const key = keyRef.current;
          if (key) void save(key);
        }}
        onCancel={() => {
          if (busy) return;
          keyRef.current = null;
          setConfirming(false);
          setConfirmError(null);
        }}
      />
    </form>
  );
}
