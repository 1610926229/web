import { formatYuan } from "@/lib/utils/format";

/**
 * 价格展示。金额以「分」传入，展示格式统一由 lib/utils/format.ts 决定。
 * 颜色、字号由调用方通过 className 控制。
 */
export default function PriceText({ cents, className = "" }: { cents: number; className?: string }) {
  return (
    <span className={`inline-flex items-baseline ${className}`}>
      <span className="text-[0.72em]">¥</span>
      <span className="font-semibold">{formatYuan(cents)}</span>
    </span>
  );
}
