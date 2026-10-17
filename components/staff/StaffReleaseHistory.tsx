import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import {
  STAFF_RELEASE_HISTORY_COMPANION_LABEL,
  STAFF_RELEASE_HISTORY_READONLY_NOTE,
  STAFF_RELEASE_HISTORY_REASON_LABEL,
  STAFF_RELEASE_HISTORY_SOURCE_LABEL,
  STAFF_RELEASE_HISTORY_TIME_LABEL,
  STAFF_RELEASE_HISTORY_TITLE,
} from "@/lib/constants/staff";
import type { StaffCompanionReleaseEntry } from "@/lib/types/staff";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 履约退出历史（P0-6）：客服在「这一单原来是谁接的、他为什么走」这个问题上的唯一答案。
 *
 * 打手在开始服务前主动取消接单之后，订单上的履约绑定会被清空（订单要能重新进公共池等人接），
 * 于是订单摘要里那行「护航」会回到「等待接单」。这两处**不是自相矛盾**：
 * 一处回答「**现在**是谁在履约」，这一段回答「**之前**是谁、为什么走、什么时候走」。
 * 用户在会话里追问「刚才那个护航去哪了」时，客服靠的就是这一段。
 *
 * ## 为什么 `entries` 为空时整段不渲染
 *
 * 客服这三页是**作业面**，不是审计面：绝大多数订单从来没有人退出过，而
 * 「该订单没有履约退出记录」这句占位会出现在每一张正常订单上——它出现得足够频繁之后，
 * 就会被读成一页装饰，等人真的退出过时同样被跳过。所以这里的取舍是
 * **有才出现，出现本身就是信号**。
 *
 * ⚠️ 管理端订单详情的同一块（`app/admin/(console)/orders/[id]/page.tsx` 的
 * `ReleaseHistorySection`）**正好相反**：空数组时显示「无退出记录」。那是**刻意的不对称**，
 * 不是漏改——审计视角要的是「查过了，没有」这个明确结论，而一片空白无法区分
 * 「没有」与「没查」。两边看起来几乎一样，但**不要顺手统一**：
 * 谁把这里的 `null` 改成占位，就等于把上面那句「出现即是信号」作废。
 *
 * ## 只读
 *
 * 本组件不取数、不发请求、没有 `"use client"`，也没有任何按钮或输入框：
 * 它只把服务端算好的 `StaffCompanionReleaseEntry[]` 画出来。退出记录是已经发生的事实，
 * 客服的职责是核对经过，不是修改（这一点也写在页面的说明里，
 * 文案来自 `STAFF_RELEASE_HISTORY_READONLY_NOTE`）。
 *
 * 排版件直接复用 `components/admin/AdminDetailSection` 的 `Section` / `DetailRow` /
 * `FieldBlock`：「只读字段长什么样」在本项目里只有这一份实现，而客服工作台的退款详情页
 * 本来就在用它们（`app/staff/(console)/refunds/[id]/page.tsx`）。
 * 这里再写一套客服版的行样式，只会让两个工作台的同一段文字长得不一样。
 */
export default function StaffReleaseHistory({
  entries,
}: {
  entries: StaffCompanionReleaseEntry[];
}) {
  if (entries.length === 0) return null;

  return (
    <Section title={STAFF_RELEASE_HISTORY_TITLE}>
      <ul className="flex flex-col">
        {entries.map((entry, index) => (
          // DTO 刻意不带记录 id（客服只需要「谁 / 怎么退的 / 什么时候 / 为什么」），
          // 因此用「打手 + 时间 + 序号」拼一个稳定 key：这是静态只读列表，序号不会引起错位。
          <li
            key={`${entry.companionId}-${entry.createdAt}-${index}`}
            className={`border-admin-line ${index > 0 ? "border-t pt-3" : ""}`}
          >
            {/* 展示的是服务端解析好的名字（`companionName` 解析不到时回落到 id），
                页面不自己去查打手档案——那会多一条数据依赖，也多一次「查不到时显示什么」的分叉 */}
            <DetailRow label={STAFF_RELEASE_HISTORY_COMPANION_LABEL} value={entry.companionName} />
            {/* 退出方式用服务端给的 `sourceLabel`，页面不按 `source` 再写一份映射表：
                两处映射迟早会给出两个说法 */}
            <DetailRow label={STAFF_RELEASE_HISTORY_SOURCE_LABEL} value={entry.sourceLabel} />
            <DetailRow
              label={STAFF_RELEASE_HISTORY_TIME_LABEL}
              value={formatDateTime(entry.createdAt)}
            />
            <div className="mt-2">
              {/* 原因是打手自己写的一句话：原样展示、保留换行、不截断。
                  为空时 `FieldBlock` 显示「—」——那是「没写」，不是「没查」，
                  所以不编一句出来。
                  ⚠️ 空**不是**不可能情况，兜底文案必须留着：P0-11 之后有两条
                  释放来源不带原因（客服直换 `staff_reassign`、封禁回池
                  `companion_disabled` 用的是固定文案），只有打手主动取消
                  （`companion_cancel`）才有用户写下的一句话。 */}
              <FieldBlock title={STAFF_RELEASE_HISTORY_REASON_LABEL} content={entry.reason ?? ""} />
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{STAFF_RELEASE_HISTORY_READONLY_NOTE}</p>
    </Section>
  );
}
