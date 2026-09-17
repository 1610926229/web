import type { Notification, NotificationInput } from "@/lib/types/notification";
import { mockNotificationRepository } from "./mockNotificationRepository";

/**
 * 系统通知的可替换仓储。
 *
 * 通知是**只读内容 + 一个已读标记 + 一条平台侧写入路径**：用户端没有任何创建通知的
 * 入口（用户不会自己给自己发通知），写入只发生在业务事件上（P0-2 起：订单退回公共池、
 * 超时自动退款……）。
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

  /**
   * 创建一条通知（P0-2）。
   *
   * ⚠️ **这不是「读—判断—写」的伪事务**，因此没有幂等键：通知不是用户提交的表单，
   * 请求重放问题在业务侧（订单超时退款本身就是幂等的，重复触发不会再退一次）。
   * 这里只保证「一条输入进去、一条记录出来」，id 与创建时间由仓储生成。
   *
   * ⚠️ 真正需要与业务写入**同段完成**的调用方（原子区段里不允许 `await`）应当使用
   * `mockNotificationRepository` 导出的**同步**写入器 `appendNotification`，
   * 而不是这个方法——理由见该文件的注释。
   */
  createNotification(input: NotificationInput): Promise<Notification>;
};

export function getNotificationRepository(): NotificationRepository {
  return mockNotificationRepository;
}
