import Link from "next/link";
import {
  STAFF_COMPLETION_DETAIL_TITLE,
  STAFF_COMPLETION_NOT_FOUND_MESSAGE,
} from "@/lib/constants/staffCompletions";

/**
 * 完成材料不存在（`/staff/completions/[id]`）。
 *
 * ⚠️ 文案与接口 404 的 message 同源（`STAFF_COMPLETION_NOT_FOUND_MESSAGE`）：
 * 页面上和接口里说两句话，会让人以为遇到了两种不同的问题。
 */
export default function StaffCompletionNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[20px] font-semibold text-ink">{STAFF_COMPLETION_NOT_FOUND_MESSAGE}</h1>
      <p className="max-w-2xl text-[13px] leading-5 text-ink-3">
        没有找到这条完成材料。它可能被写错了编号，也可能对应的订单已经不在客服可见范围内。
      </p>
      <Link
        href="/staff/completions"
        className="self-start rounded-lg border border-admin-line px-5 py-2 text-[13px] text-ink-2 hover:bg-page"
      >
        返回{STAFF_COMPLETION_DETAIL_TITLE}
      </Link>
    </div>
  );
}
