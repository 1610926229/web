import NavBar from "@/components/common/NavBar";
import RequireAuth from "@/lib/auth/RequireAuth";
import {
  TIP_CREATE_PAGE_TITLE,
  TIP_RULES_PENDING_NOTE,
  TIP_SUBMIT_DISABLED_LABEL,
  TIP_SUBMIT_DISABLED_REASON,
} from "@/lib/constants/tips";

/**
 * 送鸡腿（需登录，**本阶段不能提交**）。
 *
 * 这一页刻意只有一个说明与一个**不能点的按钮**，原因是鸡腿的价格、兑换比例、支付方式与
 * 打手结算规则都还没有确认。原型里这个入口是存在的，因此保留入口与页面的骨架，
 * 但不做任何「先按一个价格跑通流程」的事——那会把一个自造的价格变成事实。
 *
 * 因此这一页**不读任何数据、不发任何请求**：
 * - 不调用 P4 的支付链路，不产生 `PaymentRequest`、订单或鸡腿记录；
 * - 没有「模拟支付成功」按钮（那会在数据里留下一条来路不明的记录）；
 * - 关联订单与打手只画出骨架并标明「待开放」，不去列出用户的真实订单——
 *   列出来的下一步一定是「选中它」，而选中之后无处可去。
 *
 * 禁用按钮旁边**必须写明为什么不能提交**：光有一个灰按钮，用户只会以为页面坏了。
 * 理由同时作为按钮的无障碍名称，读屏用户也能得到同一句解释。
 */
export default function TipCreatePage() {
  return (
    <>
      <NavBar title={TIP_CREATE_PAGE_TITLE} showBack />

      <RequireAuth>
        {() => <TipCreateSkeleton />}
      </RequireAuth>
    </>
  );
}

function TipCreateSkeleton() {
  return (
    <div className="flex flex-1 flex-col bg-page pb-8">
      {/* 为什么不能提交：写在最前面，不让用户自己猜 */}
      <section className="bg-surface px-4 py-4">
        <h2 className="text-[15px] font-medium text-ink">规则待确认</h2>
        <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{TIP_RULES_PENDING_NOTE}</p>

        <ul className="mt-3 flex flex-col gap-1.5">
          {[
            { label: "鸡腿价格", note: "单个鸡腿的价格尚未确定，因此这里不显示任何金额" },
            { label: "支付方式", note: "是否接入微信支付、如何发起支付尚未确定" },
            { label: "打手结算", note: "平台与打手的结算规则尚未确定，页面不展示到手金额" },
          ].map((item) => (
            <li
              key={item.label}
              className="flex gap-2 border-b border-line py-1.5 text-[12px] leading-4 last:border-b-0"
            >
              <span className="shrink-0 text-ink-2">{item.label}</span>
              <span className="shrink-0 rounded-full bg-page px-2 text-[11px] leading-5 text-ink-3">
                待确认
              </span>
              <span className="min-w-0 flex-1 text-ink-3">{item.note}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* 表单骨架：结构与将来一致，但每一项都是不可交互的说明 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">送鸡腿</h2>

        <div className="mt-2">
          <SkeletonRow label="关联订单" value="选择订单" hint="待开放" />
          <SkeletonRow label="打手" value="自动取该订单的打手" hint="待开放" />
          {/* 数量只写成「—」：本阶段没有单价，写下任何数字都会被当成价格 */}
          <SkeletonRow label="鸡腿数量" value="—" hint="价格待确认" />
          <SkeletonRow label="支付方式" value="待确认" hint="待开放" />
        </div>
      </section>

      <div className="mt-3 px-4">
        {/* 按钮禁用 + 理由：两者必须同时出现，不能只给一个灰按钮 */}
        <button
          type="button"
          disabled
          aria-disabled
          aria-describedby="tip-submit-disabled-reason"
          className="h-11 w-full rounded-full bg-ink py-3 text-[15px] font-medium text-white opacity-40"
        >
          {TIP_SUBMIT_DISABLED_LABEL}
        </button>
        <p
          id="tip-submit-disabled-reason"
          role="note"
          className="mt-2 text-center text-[12px] leading-4 text-ink-3"
        >
          {TIP_SUBMIT_DISABLED_REASON}：鸡腿的价格、支付方式与打手结算规则确认后才会开放提交。
        </p>
      </div>
    </div>
  );
}

/** 骨架行：只展示结构与「待开放」，不是可交互的控件（因此没有 input，也没有 onClick）。 */
function SkeletonRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-line py-2.5 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-2">{label}</span>
      <span className="ml-auto shrink-0 text-ink-3">{value}</span>
      <span className="shrink-0 rounded-full bg-page px-2 text-[11px] leading-5 text-ink-3">
        {hint}
      </span>
    </div>
  );
}
