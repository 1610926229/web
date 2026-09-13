"use client";

/* eslint-disable @next/next/no-img-element -- 公告图为本地 SVG 占位图，不经 next/image 优化器。 */
import { useEffect, useState } from "react";
import type { AnnouncementImage } from "@/lib/types/content";

/**
 * 首页公告滚动窗口。
 *
 * 定位：仅做**图片自动循环展示**。
 * - 不响应点击、不跳转，因此数据结构中没有 link 字段，此处也不做任何跳转处理；
 * - 图片加载失败时降级为占位提示，避免出现破图；
 * - 内容由管理端上传，当前使用本地占位图。
 */
export default function AnnouncementCarousel({
  images,
  intervalMs = 3000,
}: {
  images: AnnouncementImage[];
  intervalMs?: number;
}) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (images.length <= 1) return;
    const timer = window.setInterval(() => {
      setIndex((i) => (i + 1) % images.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [images.length, intervalMs]);

  if (images.length === 0) return null;

  const current = images[index];

  return (
    <div role="region" aria-label="公告" className="relative h-12 w-full overflow-hidden bg-brand-yellow">
      {failed[current.id] ? (
        <p className="flex h-full items-center justify-center gap-1 text-[14px] font-semibold text-brand-red">
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4.5M12 16h.01" />
          </svg>
          公告图片加载失败
        </p>
      ) : (
        <img
          key={current.id}
          src={current.imageUrl}
          alt={current.alt}
          className="h-full w-full object-cover"
          onError={() => setFailed((prev) => ({ ...prev, [current.id]: true }))}
        />
      )}
    </div>
  );
}
