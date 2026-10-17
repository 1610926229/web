"use client";

import {
  ImageMaterialForm,
  type ImageMaterialFormBodyProps,
  type ImageMaterialFormCopy,
} from "@/components/admin/AdminAnnouncementForm";

/**
 * 活动 Banner 的编辑 / 新建表单。
 *
 * ⚠️ 实现与图片公告**只有一份**（`AdminAnnouncementForm.tsx` 导出的
 * `ImageMaterialForm`）：字段完全相同，校验也是同一份
 * （`contentImageFieldErrors()` / `normalizeBannerProfilePatch()`）。
 * 本文件只补几句话——它们说的是用户端会怎么变，只有 Banner 自己知道。
 */

const BANNER_FORM_COPY: ImageMaterialFormCopy = {
  createTitle: "新增活动 Banner",
  editTitle: "编辑活动 Banner",
  usageNotice:
    "用户端首页只有**一张**活动展示图，取的是排序最前面的那张启用图。" +
    "因此「排序」在这里不是偏好，而是「现在前台看到的是哪一张」的答案；" +
    "把这张停用，前台会换成排序最前的另一张启用图——一张都没有时活动位整个消失。",
  createdMessage: "已新增。它启用且排序最靠前时，用户端首页的活动图就是它",
  savedMessage: "已保存。用户端下一次刷新就是新素材",
  unchangedMessage: "内容没有变化，未写入。列表里显示的就是服务端当前的记录",
  replayedMessage: "这次提交与刚才那次是同一次操作，服务端没有重复写入；用户端看到的就是刚才那次的结果",
};

export default function AdminBannerForm(props: ImageMaterialFormBodyProps) {
  return <ImageMaterialForm {...props} copy={BANNER_FORM_COPY} />;
}
