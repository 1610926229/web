import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import EmptyState from "@/components/common/EmptyState";
import {
  COMPANION_DETAIL_PAGE_TITLE,
  COMPANION_NOT_FOUND_DESCRIPTION,
  COMPANION_NOT_FOUND_TITLE,
} from "@/lib/constants/companions";

/**
 * 陪玩不存在（ID 取不到数据，链接失效）。
 *
 * 与「已下架」区分开：**下架陪玩仍然能打开详情**（页面上标注「当前不可提供服务」、
 * 没有任何选择入口），这里是连资料都取不到。
 *
 * 退路指向 `/companions` 而不是首页：用户是从名单点进来的，回到名单比回到首页更接近他原本在做的事。
 */
export default function CompanionNotFound() {
  return (
    <>
      <NavBar title={COMPANION_DETAIL_PAGE_TITLE} showBack />

      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState title={COMPANION_NOT_FOUND_TITLE} description={COMPANION_NOT_FOUND_DESCRIPTION} />

        <Link
          href="/companions"
          className="rounded-full border border-line px-6 py-2 text-[14px] text-ink-2"
        >
          返回陪玩列表
        </Link>
      </div>
    </>
  );
}
