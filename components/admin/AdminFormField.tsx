"use client";

import type { ReactNode } from "react";

/**
 * 管理端表单的字段容器（标签 / 说明 / 错误 / 字数统计）与开关按钮。
 *
 * 抽出来是因为 P8B 之后有四个表单要用同一套东西（入驻审核、护航编辑、类目编辑、
 * 商品编辑）。四份复制粘贴的问题是：无障碍上的那几条硬要求（错误用
 * `role="alert"` 播报、错误与控件用 `aria-describedby` 关联、错误 id 唯一）
 * 只要有一份漏了，那一页的读屏体验就是坏的，而漏掉的地方从代码上看不出来。
 *
 * ⚠️ 这里**不做任何校验**：错误文本由各表单从 `lib/constants/*` 的同名校验函数取来，
 * 传进来只负责显示。校验只有在常量层做一次，前后端才是同一份规则。
 */
export function AdminField({
  label,
  hint,
  error,
  errorId,
  counter,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  errorId?: string;
  counter?: ReactNode;
  /**
   * 传入时标签是一个真正的 `<label for>`；不传时（勾选组、单选组）标签只是视觉标题，
   * 真正的可访问名由内部控件的 `aria-label` 承担。
   */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13px] text-ink-2">
            {label}
          </label>
        ) : (
          <span className="text-[13px] text-ink-2">{label}</span>
        )}
        {counter}
      </div>
      {children}
      {hint ? <span className="text-[12px] leading-4 text-ink-3">{hint}</span> : null}
      {error ? (
        <span id={errorId} role="alert" className="text-[12px] leading-4 text-brand-red">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 二选一（或几选一）的开关按钮组里的一颗按钮。
 *
 * 用 `role="radio"` + `aria-checked` 而不是「选中就变蓝」的普通按钮：
 * 读屏用户需要知道「这是一组互斥选项，当前选中的是哪个」。
 * 组容器由调用方给出 `role="radiogroup"` 与 `aria-label`。
 *
 * ⚠️ 这里**没有 `aria-invalid`**：`role="radio"` 不支持这个属性（`jsx-a11y` 会报，
 * 读屏也不认）。错误关联走两条路——字段的错误文案由组容器用 `aria-describedby`
 * 指向，而容器带 `tabIndex={-1}`，所以「第一条错误自动聚焦」落在容器上时，
 * 读屏念出的正是那句错误。
 */
export function AdminToggleButton({
  active,
  disabled,
  label,
  onClick,
  ariaDescribedBy,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  ariaDescribedBy?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-4 py-1.5 text-[13px] disabled:opacity-40 ${
        active ? "border-admin-accent bg-brand-blue-soft text-ink" : "border-admin-line text-ink-2"
      }`}
    >
      {label}
    </button>
  );
}
