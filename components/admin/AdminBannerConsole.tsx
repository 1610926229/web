"use client";

import AdminBannerForm from "@/components/admin/AdminBannerForm";
import AdminBannerTable from "@/components/admin/AdminBannerTable";
import {
  ImageMaterialConsole,
  type ImageMaterialConsoleBinding,
  type ImageMaterialConsoleCopy,
} from "@/components/admin/AdminAnnouncementConsole";
import {
  normalizeBannerProfilePatch,
  type ContentRemovalFilter,
} from "@/lib/constants/adminContent";
import {
  createAdminBanner,
  disableBanner,
  enableBanner,
  fetchAdminBanners,
  removeBanner,
  saveBannerProfile,
} from "@/lib/services/adminHttp";
import type { AdminContentList } from "@/lib/types/content";
import type { ImageMaterialRow } from "@/components/admin/AdminAnnouncementTable";

/**
 * 活动 Banner 的管理界面。
 *
 * ⚠️ 实现与图片公告**只有一份**（`AdminAnnouncementConsole.tsx` 导出的
 * `ImageMaterialConsole`）：两者要处理的状态完全一样——筛选、加载、错误、
 * 二次确认、幂等键的生命周期、写成功后重取列表。Banner 的这份只换
 * **服务函数与文案**，因为差别只在用户端怎么用它。
 *
 * ⚠️ 这份文案里最关键的一句是「用户端只展示排序最前的一张启用图」：
 * 不说清楚，运营会以为这里是轮播的素材库，然后把排序和启用状态当成
 * 「个人偏好」随便调，而它们其实直接决定前台看到什么。
 */
const BANNER_BINDING: ImageMaterialConsoleBinding = {
  slug: "banner",
  normalize: normalizeBannerProfilePatch,
  list: fetchAdminBanners,
  create: createAdminBanner,
  save: saveBannerProfile,
  enable: enableBanner,
  disable: disableBanner,
  remove: removeBanner,
};

const BANNER_CONSOLE_COPY: ImageMaterialConsoleCopy = {
  newLabel: "新增 Banner",
  enableMessage: "已启用：它排在最前面时，用户端首页的活动图就是它",
  disableMessage:
    "已停用：用户端首页会换成排序最前的另一张启用图；记录与图片都保留，随时可以重新启用",
  removeMessage: "已移除：用户端立即不可见，记录保留可回查",
  unchangedActionMessage:
    "这张图已经是目标状态，这次没有写入任何改动（可能是另一位管理员刚改过）；列表已按服务端最新的记录刷新——用户端首页现在用的是哪一张，以列表顺序为准",
  replayedActionMessage:
    "这次操作与刚才那次是同一个请求，服务端没有重复写入；列表显示的就是刚才那次的结果",
  disableConfirm:
    "停用后用户端立即看不到这张图。如果它本来排在第一位，首页的活动图会换成排序最前的另一张启用图——" +
    "一张启用的都没有时，活动位会整个消失。可以再次启用。",
  removeConfirm:
    "移除后用户端立即不可见，记录保留可回查。移除是**不可撤销**的——之后不能再编辑或重新启用这条记录，" +
    "需要用到这张图时请新建一条。",
};

export default function AdminBannerConsole({
  initialResult,
  initialRemoval,
}: {
  initialResult: AdminContentList<ImageMaterialRow>;
  initialRemoval: ContentRemovalFilter;
}) {
  return (
    <ImageMaterialConsole
      binding={BANNER_BINDING}
      copy={BANNER_CONSOLE_COPY}
      headingTitle="活动 Banner"
      headingDescription={
        "后台可以预置多张活动图（提前备好素材），但用户端首页**只展示排序最前的那一张启用图**，不是轮播。" +
        "排序与启用状态因此直接决定前台看到的是哪一张；改完用户端刷新即可见，两处读的是同一份数据。"
      }
      initialResult={initialResult}
      initialRemoval={initialRemoval}
      Table={AdminBannerTable}
      Form={AdminBannerForm}
    />
  );
}
