import Link from "next/link";
import {
  ADMIN_DASHBOARD_QUICK_ENTRIES,
  ADMIN_DASHBOARD_QUICK_HINT,
  ADMIN_DASHBOARD_QUICK_TITLE,
} from "@/lib/constants/adminDashboard";

/**
 * 经营首页的「快捷入口」（P1-1）。
 *
 * 一个**服务端组件**，因为它没有任何状态：入口清单是常量，不随取数变化，
 * 也不需要局部重试——它永远不会「加载失败」。
 *
 * ⚠️ 每一项的 `href` / `label` / `description` **都来自 `ADMIN_NAV_ITEMS`**
 * （见 `lib/constants/adminDashboard.ts` 的 `dashboardQuickEntry()`），
 * 这里只是把它们摆成网格。因此：
 *
 * - 不会出现「首页上的入口指向一个改名后的旧地址」；
 * - 不会出现假入口——清单里每一项都真的对应一个已开放的模块；
 * - 侧栏加一个新模块时这里**不会自动多出来**（快捷入口是「常用」，不是「全部」），
 *   想加就在常量表里加一行，那时由 `dashboardQuickEntry()` 保证新键真的存在。
 */
export default function AdminQuickEntries() {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[16px] font-semibold text-ink">{ADMIN_DASHBOARD_QUICK_TITLE}</h2>
        <p className="text-[12px] text-ink-3">{ADMIN_DASHBOARD_QUICK_HINT}</p>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ADMIN_DASHBOARD_QUICK_ENTRIES.map((entry) => (
          <li key={entry.key}>
            <Link
              href={entry.href}
              className="flex h-full flex-col gap-1 rounded-xl border border-admin-line bg-surface p-4 transition-colors hover:border-admin-accent"
            >
              <span className="text-[14px] font-medium text-ink">{entry.label}</span>
              <span className="text-[12px] leading-4 text-ink-3">{entry.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
