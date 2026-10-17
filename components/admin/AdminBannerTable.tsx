"use client";

import {
  ImageMaterialTable,
  type ImageMaterialTableBodyProps,
} from "@/components/admin/AdminAnnouncementTable";

/**
 * 活动 Banner 的后台列表。
 *
 * ⚠️ 实现与图片公告**只有一份**（`AdminAnnouncementTable.tsx` 导出的
 * `ImageMaterialTable`）：两者在数据形状上确实是同一种东西——一张图 +
 * 一个后台标题 + 一句读屏说明 + 排序 + 启用（见 `lib/constants/adminContent.ts`）。
 * 差别只在用户端怎么用，而那正是本文件唯一要补的两句话。
 *
 * ⚠️ 用户端首页**只展示排序最前的一张启用图**（`selectActivityImageUrl()`），
 * 不是轮播。后台因此可以预置多张素材，但「现在前台看到的是哪一张」永远只有一个答案。
 */
export default function AdminBannerTable(props: ImageMaterialTableBodyProps) {
  return (
    <ImageMaterialTable
      {...props}
      noun="活动 Banner"
      listTitle="活动 Banner"
      listDescription={
        "用户在首页看到的只有**一张**活动展示图，取排序最前面的那张启用图。" +
        "因此这里的排序不是「一堆图之间的偏好」，而是「现在前台看到的是哪一张」这个唯一答案的输入。"
      }
      footerNote={
        "排序值越小越靠前；把某一张排到第一位并启用，用户端下一次刷新就会换成它。" +
        "一张启用的都没有时，首页的活动位会整个消失（不会显示占位图）。"
      }
    />
  );
}
