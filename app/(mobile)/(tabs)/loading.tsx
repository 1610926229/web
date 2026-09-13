/**
 * 一级 Tab 页面的加载边界（服务端流式渲染）。
 *
 * 它是 `(tabs)` 布局 children 的 Suspense 兜底，渲染在布局内部，
 * 因此加载过程中底部导航照常显示、位置不变。
 *
 * 静态预渲染的页面（分类、帮助等）不会触发本兜底。
 */
export default function TabsLoading() {
  return (
    <div className="flex flex-1 items-center justify-center bg-surface px-4 py-16">
      <p className="text-[14px] text-ink-3">加载中…</p>
    </div>
  );
}
