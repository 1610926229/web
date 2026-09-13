"use client";

/* eslint-disable @next/next/no-img-element -- 商品主图为本地 SVG 占位图，不经 next/image 优化器。 */
import { useState } from "react";

/**
 * 商品主图。
 *
 * 必须由客户端渲染：图片是否加载成功只有浏览器知道，加载失败时要换成占位块，
 * 而不是留一个破图图标。
 */
export default function ProductMainImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex aspect-square w-full items-center justify-center bg-page">
        <p className="text-[13px] text-ink-3">主图加载失败</p>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className="aspect-square w-full bg-brand-blue-soft object-cover"
    />
  );
}
