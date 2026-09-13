import { notificationSeed } from "@/lib/mocks/fixtures/notificationSeed";
import type { Notification } from "@/lib/types/notification";
import { getMockStore } from "./mockStore";
import type { NotificationRepository } from "./notificationRepository";

/**
 * 系统通知的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（后台推送写入同一张表），
 * 本文件的删除不影响上层接口。
 *
 * 已读标记直接写在通知记录上（`readAt`），而不是另存一份「用户已读表」：
 * 通知本来就是一人一条，不存在多个用户共享一条通知的情况。
 */

type MockNotificationStore = {
  notifications: Map<string, Notification>;
};

function createStore(): MockNotificationStore {
  return { notifications: new Map(notificationSeed.map((item) => [item.id, item])) };
}

function store(): MockNotificationStore {
  return getMockStore("notification", createStore);
}

export const mockNotificationRepository: NotificationRepository = {
  async listNotifications(userId) {
    return [...store().notifications.values()].filter((item) => item.userId === userId);
  },

  async findNotificationById(id) {
    return store().notifications.get(id) ?? null;
  },

  async markNotificationRead(id, userId, readAt) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const notification = current.notifications.get(id);
    // 不存在与不属于你表现完全一致：无法用接口枚举别人的通知 id
    if (!notification || notification.userId !== userId) return null;

    // 已读时间只写一次：重复标记不会把「什么时候读的」刷新成现在
    if (notification.readAt) return notification;

    const updated: Notification = { ...notification, readAt };
    current.notifications.set(id, updated);
    // —— 原子区段结束 ——

    return updated;
  },
};
