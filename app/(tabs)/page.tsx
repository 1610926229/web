/* eslint-disable @next/next/no-img-element -- 活动展示图为本地 SVG 占位图，不经 next/image 优化器。 */
import EmptyState from "@/components/common/EmptyState";
import AnnouncementCarousel from "@/components/home/AnnouncementCarousel";
import HomeShortcutGrid from "@/components/home/HomeShortcutGrid";
import ProductSection from "@/components/home/ProductSection";
import { getHomeData } from "@/lib/services/home";
import type { HomeData } from "@/lib/types/content";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 首页 —— **Server Component**。
 *
 * 首屏数据在服务端直接取到并输出进 HTML：公告、活动展示图、快捷入口、商品都在源码里，
 * 浏览器不需要为了首屏再发一次请求。确实依赖浏览器状态的部分（公告自动轮播）已单独
 * 拆成小型 Client Component，本文件与其余首页模块都保持服务端渲染。
 *
 * 取数经 `lib/services/home`，页面不接触接口路径，也不引用 Mock 数据模块。
 * 加载态由同路由组的 `loading.tsx` 兜底、错误态由 `error.tsx` 兜底——两者都在布局
 * 内部渲染，因此底部导航在所有状态下都照常显示。
 *
 * 验收期可用查询参数观察各状态（需 `ENABLE_MOCK_DEBUG=true`，关闭时参数被完全忽略）：
 * `/?mockDelay=3000` 看加载态、`/?mockError=1` 看错误态、`/?mockEmpty=1` 看商品区局部空态。
 */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  // 查询参数原样交给 service，页面不判断开关、也不关心哪些参数有意义；
  // 与 /api/home 的处理方式完全一致，两处行为不会分叉。
  const data = await getHomeData(toSearchParams(await searchParams), "server");

  return <HomeModules data={data} />;
}

/**
 * 首页各模块的组装与**模块级**空态判断。
 *
 * 关键约定：每个模块只依据自己的数据决定显示还是隐藏，任何**单一**模块为空都不允许
 * 替换掉整页内容——公告、活动图、快捷入口、商品四者彼此独立。
 * 只有四者同时为空，才轮到整页空态。
 */
function HomeModules({ data }: { data: HomeData }) {
  const hasAnnouncements = data.announcements.length > 0;
  const hasActivity = data.activityImageUrl.length > 0;
  const hasShortcuts = data.shortcuts.length > 0;
  const hasProducts = data.sections.length > 0;

  if (!hasAnnouncements && !hasActivity && !hasShortcuts && !hasProducts) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface px-4 py-16">
        <EmptyState
          title="暂无内容"
          description="首页内容正在准备中，请稍后再来。"
        />
      </div>
    );
  }

  return (
    <>
      {/* 公告滚动窗口：仅图片循环展示，不响应点击 */}
      {hasAnnouncements ? <AnnouncementCarousel images={data.announcements} /> : null}

      {/* 活动展示图：内容由管理端配置，当前为占位图 */}
      {hasActivity ? (
        <section className="bg-surface px-3 pb-1 pt-3">
          <img
            src={data.activityImageUrl}
            alt="活动展示图（占位）"
            className="w-full rounded-[12px] bg-brand-blue-soft"
          />
        </section>
      ) : null}

      {hasShortcuts ? <HomeShortcutGrid shortcuts={data.shortcuts} /> : null}

      {/* 商品分组：仅有商品为空时，只让这一段进入空态 */}
      {hasProducts ? (
        data.sections.map((section) => (
          <ProductSection key={section.id} section={section} />
        ))
      ) : (
        <section className="mt-2 bg-surface px-4 pb-10 pt-8">
          <EmptyState
            title="暂无商品"
            description="当前没有可展示的商品分组，请稍后再来。"
          />
        </section>
      )}
    </>
  );
}
