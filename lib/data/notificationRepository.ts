import type { Notification } from "@/lib/types/notification";
import { mockNotificationRepository } from "./mockNotificationRepository";

/**
 * 系统通知的可替换仓储。
 *
 * 通知是**只读内容 + 一个已读标记**：本阶段没有任何创建通知的用户入口
 * （通知来自平台侧，用户端不会自己给自己发通知），因此这里只有查询与标记已读。
 *
 * 已读标记属于「用户自己的状态」，只能由本人改动；`markNotificationRead` 在同一段
 * 同步代码里同时校验归属与写入，不属于当前用户的 id 一律返回 null（对外是 404）。
 */

export type NotificationRepository = {
  /** 某个用户的全部通知。排序（最新在前）由服务层决定，仓储只负责取全量。 */
  listNotifications(userId: string): Promise<Notification[]>;

  /** 按 id 取单条通知（不做归属判断，归属由服务层校验）。 */
  findNotificationById(id: string): Promise<Notification | null>;

  /**
   * 标记已读。**幂等**：已经是已读的通知再次标记不会改动原来的已读时间
   * （否则用户每次进页面都会把「什么时候读的」刷新成现在）。
   * 通知不属于该用户时返回 null。
   */
  markNotificationRead(id: string, userId: string, readAt: string): Promise<Notification | null>;
};

export function getNotificationRepository(): NotificationRepository {
  return mockNotificationRepository;
}
