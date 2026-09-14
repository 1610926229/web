import type { ReactNode } from "react";

/**
 * 管理端详情页的**只读**排版件：区块（`Section`）、字段行（`DetailRow`）、长文本块（`FieldBlock`）。
 *
 * 抽出来是因为 P8C 的三个详情页（订单 / 退款 / 投诉）都要用同一套排版：
 * 三处的字段完全不同，但「只读字段长什么样」必须一模一样——
 * 它靠**位置和形状**传达「这里没有编辑入口」，而不是每次都重写一句说明。
 * 与 `AdminStatItem` 抽取的理由相同（那里是类目详情与商品详情）。
 *
 * ⚠️ 三个组件都**只显示**：没有任何输入框、按钮或 `contentEditable`。
 * 需要写操作时另开客户端组件（如 `AdminRefundConsole`），并且只把服务端允许的动作放进去。
 *
 * ⚠️ 入驻申请详情页里还留着一份同形的私有实现（P8B 已有代码，本阶段不改动它）——
 * 不是「忘了换过来」，而是不为了统一写法去动已经通过验收的页面。
 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** 一行的字段展示：标签 + 值。值为空时显示「—」，不留空白让人以为页面坏了。 */
export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-20 shrink-0 text-[13px] text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-ink-2">{value || "—"}</span>
    </div>
  );
}

/** 长文本块：保留换行展示。用户写的内容不做任何截断或改写。 */
export function FieldBlock({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <p className="text-[13px] text-ink-3">{title}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
        {content || "—"}
      </p>
    </div>
  );
}
