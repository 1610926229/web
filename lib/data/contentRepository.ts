import type {
  AdminAnnouncementProfilePatch,
  AdminBannerProfilePatch,
  AdminQuickEntryProfilePatch,
  ContentAnnouncementRecord,
  ContentBannerRecord,
  QuickEntryRecord,
} from "@/lib/types/content";
import { mockContentRepository } from "./mockContentRepository";

/**
 * 首页运营内容（图片公告 / 活动 Banner / 快捷入口）的**可替换仓储**（读写）。
 *
 * ⚠️ **全站只有这一份运营内容**。首页与「我的」页读的是这里，管理后台改的也是这里，
 * 因此「后台改完公告，用户端刷新就是新的」不是靠任何同步动作做到的，
 * 而是因为两边读的本来就是同一条记录。**禁止再建第二份公告 / 入口名单**。
 *
 * ## 仓储与业务规则的分工
 *
 * 本层只负责**存取**与「一份数据」的一致性，**不判断**下面这些事：
 *
 * - 「哪些记录用户端看得到」——那是 `lib/constants/homeContent.ts` 的
 *   `isContentVisible()` / `selectPublicAnnouncements()` 等纯函数。
 *   放这里的话，换成数据库时这条业务规则会被 SQL 悄悄替换掉，而它不该随存储改变。
 * - 「路径安不安全」「标题多长」——那是 `lib/constants/adminContent.ts` 与
 *   `lib/constants/safePath.ts`，由事务层在写入前调用。
 * - 「移除后还能不能改」——那是 `lib/data/adminContentTransaction.ts` 的原子区段。
 *
 * ## 读方法的两种口径
 *
 * `list*Records()` 一律返回**全部记录（含停用与已移除）**，不做任何过滤：
 * 后台要能看见前台看不见的那些，而用户端的可见性规则在纯函数里，
 * 两者都在同一份原始数据上做各自的事。这样不存在「后台查不到自己刚停用的那条」
 * 这类因为两套查询口径不同步而产生的问题。
 */

/**
 * 一次后台写操作的返回：改动前后的记录。
 *
 * ⚠️ 与商品目录的 `{ previous, updated } | null` 保持同一形状。
 * 返回 `previous` 而不是只返回 `updated`：审计快照需要 before/after 两份，
 * 而 before 必须在**原子区段内**取——写完之后再去读一次，读到的已经是新值了。
 */
export type ContentWriteResult<T> = { previous: T; updated: T };

/**
 * 后台可编辑的公告字段 + 服务端时间戳。
 *
 * 时间戳由调用方传入而不是仓储自己取 `new Date()`：业务写入与审计写入必须
 * 共用**同一个** `at`（见 `lib/data/adminWriteSupport.ts` 的 `AdminWriteContext`），
 * 仓储自己取时间会让两者差几毫秒，而审计的意义正是「这一刻发生了什么」。
 */
export type ContentAnnouncementPatch = AdminAnnouncementProfilePatch & { at: string };
export type ContentBannerPatch = AdminBannerProfilePatch & { at: string };
export type ContentQuickEntryPatch = AdminQuickEntryProfilePatch & { at: string };

export type ContentRepository = {
  /** 全部图片公告（含停用与已移除），未排序。排序在纯函数里做。 */
  listAnnouncementRecords(): Promise<ContentAnnouncementRecord[]>;

  /**
   * 按 id 取公告，**含已移除的**。
   *
   * ⚠️ 与商品目录的 `findProductById()` / `findProductForAdmin()` 那对方法**刻意不同**：
   * 那里分成两个方法，是因为「用户端详情」与「后台详情」对已移除记录的期望不同。
   * 这里只有一个调用方——后台，因此不再拆。真出现一个需要「取不到已移除记录」的
   * 消费方时再加，而不是先预备一个没有调用点的窄方法。
   */
  findAnnouncementById(id: string): Promise<ContentAnnouncementRecord | null>;

  /** 新建一条公告。id 由调用方在原子区段内生成。 */
  createAnnouncement(record: ContentAnnouncementRecord): Promise<ContentAnnouncementRecord>;

  /** 覆盖式更新公告的可编辑字段；记录不存在返回 null。 */
  updateAnnouncement(
    id: string,
    patch: ContentAnnouncementPatch,
  ): Promise<ContentWriteResult<ContentAnnouncementRecord> | null>;

  /**
   * 只改公告的启用状态（启用 / 停用走同一条路径）。
   *
   * ⚠️ 单独开一个窄写入器，而不是复用 `updateAnnouncement()`：后台列表上的
   * 「停用」按钮只应当改这一个字段，**绝不能**顺带把标题、图片、排序一起写回去——
   * 那需要调用方先把整条记录读出来再拼一个完整 patch，而那份读取发生在原子区段之外，
   * 两位管理员同时操作时后写入的那次会把另一位刚改好的标题覆盖回旧值。
   */
  setAnnouncementEnabled(
    id: string,
    enabled: boolean,
    at: string,
  ): Promise<ContentWriteResult<ContentAnnouncementRecord> | null>;

  /** 软移除公告：只写 `removedAt`，**不删除记录**。已移除的幂等返回同一份。 */
  markAnnouncementRemoved(
    id: string,
    at: string,
  ): Promise<ContentWriteResult<ContentAnnouncementRecord> | null>;

  /** 全部活动 Banner（含停用与已移除）。 */
  listBannerRecords(): Promise<ContentBannerRecord[]>;

  findBannerById(id: string): Promise<ContentBannerRecord | null>;

  createBanner(record: ContentBannerRecord): Promise<ContentBannerRecord>;

  updateBanner(
    id: string,
    patch: ContentBannerPatch,
  ): Promise<ContentWriteResult<ContentBannerRecord> | null>;

  setBannerEnabled(
    id: string,
    enabled: boolean,
    at: string,
  ): Promise<ContentWriteResult<ContentBannerRecord> | null>;

  markBannerRemoved(
    id: string,
    at: string,
  ): Promise<ContentWriteResult<ContentBannerRecord> | null>;

  /** 全部快捷入口（含停用与已移除）。 */
  listQuickEntryRecords(): Promise<QuickEntryRecord[]>;

  findQuickEntryById(id: string): Promise<QuickEntryRecord | null>;

  createQuickEntry(record: QuickEntryRecord): Promise<QuickEntryRecord>;

  updateQuickEntry(
    id: string,
    patch: ContentQuickEntryPatch,
  ): Promise<ContentWriteResult<QuickEntryRecord> | null>;

  setQuickEntryEnabled(
    id: string,
    enabled: boolean,
    at: string,
  ): Promise<ContentWriteResult<QuickEntryRecord> | null>;

  markQuickEntryRemoved(
    id: string,
    at: string,
  ): Promise<ContentWriteResult<QuickEntryRecord> | null>;
};

export function getContentRepository(): ContentRepository {
  return mockContentRepository;
}
