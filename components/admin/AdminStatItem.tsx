/**
 * 详情页只读区块里的一格统计（标签 + 数值 + 可选说明）。
 *
 * 抽出来是因为类目详情与商品详情都要用同一套「只读字段」的排版：
 * 两处的字段不同，但「哪些是系统维护、后台改不了」这件事必须长得一模一样——
 * 它靠**位置和形状**传达，而不是靠每次重新写一句说明。
 *
 * ⚠️ 这里只显示，不提供任何编辑入口：销量、平台标签、创建时间这类字段
 * 在服务端的写白名单里根本没有位置，给它们一个输入框只会让人以为改了有用。
 */
export default function AdminStatItem({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** 值的补充说明（如「只数未移除的商品」），用于解释这个数字的口径 */
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-admin-line px-3 py-2">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">{value}</dd>
      {hint ? <p className="text-[11px] text-ink-3">{hint}</p> : null}
    </div>
  );
}
