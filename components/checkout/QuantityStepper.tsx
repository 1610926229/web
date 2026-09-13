"use client";

/**
 * 购买数量步进器。
 *
 * 上下限由调用方传入（服务端的 `MAX_QUANTITY` 是同一份约束）：前端只是提前拦住，
 * 真正的判定在服务端——数量越界的请求会被直接拒绝。
 */
export default function QuantityStepper({
  value,
  min = 1,
  max,
  disabled = false,
  onChange,
}: {
  value: number;
  min?: number;
  max: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const buttonClass =
    "flex h-8 w-8 items-center justify-center rounded-[6px] bg-page text-[18px] leading-none text-ink-2 disabled:opacity-40";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label="减少数量"
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
        className={buttonClass}
      >
        −
      </button>

      <span aria-live="polite" className="min-w-[2.25rem] text-center text-[16px] font-semibold text-ink">
        {value}
      </span>

      <button
        type="button"
        aria-label="增加数量"
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        className={buttonClass}
      >
        +
      </button>
    </div>
  );
}
