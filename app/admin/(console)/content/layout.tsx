import AdminContentTabs from "@/components/admin/AdminContentTabs";

/**
 * 运营内容子模块的壳层（`/admin/content/**`）。
 *
 * 四个子页签（图片公告 / 活动 Banner / 快捷入口 / 协议与版本）在这一层渲染，
 * 因此从页签之间来回切时**它不会重新挂载**：运营不会在切回来时丢掉
 * 「我刚才在哪一项上」的视觉位置。
 *
 * ⚠️ 鉴权与侧栏在上一层（`app/admin/(console)/layout.tsx`）已经做过了，这里不重复。
 * 这一层只负责一件事：把子页签固定在这四个页面顶上。
 *
 * ⚠️ 这里**不放** `loading.tsx`：那会把这四个子页面连同它们各自的加载边界
 * 一起罩住，反而让每个子页自己的骨架屏失效（细节见各子目录的 `loading.tsx`）。
 */
export default function AdminContentLayout({ children }: LayoutProps<"/admin/content">) {
  return (
    <div className="flex flex-col gap-5">
      <AdminContentTabs />
      {children}
    </div>
  );
}
