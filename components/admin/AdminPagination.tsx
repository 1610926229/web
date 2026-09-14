"use client";

/**
 * 管理端分页控件。
 *
 * P8D-1 起实现搬到了 `components/common/Pagination.tsx`：客服工作台要用**同一个**
 * 分页控件，而它没有一句文案与业务有关。这个文件只保留 `AdminPagination` 这个名字，
 * 免得管理端的六个列表页跟着改一遍 import。
 */
export { default } from "@/components/common/Pagination";
