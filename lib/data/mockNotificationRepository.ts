import { notificationSeed } from "@/lib/mocks/fixtures/notificationSeed";
import type { Notification, NotificationInput } from "@/lib/types/notification";
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
 *
 * 写入分两条路，**必须分清**：
 *
 * | 调用方 | 用哪个 | 为什么 |
 * |---|---|---|
 * | 服务层（`createNotificationForUser`） | `createNotification`（异步） | 它不在任何原子区段里 |
 * | 业务事务的原子区段（订单超时退款、订单退回公共池） | `appendNotification`（**同步**） | 区段内出现 `await` 就是 bug，通知必须与业务数据同段写下去 |
 *
 * 两条路写的是同一个 Map，因此不存在「事务写的通知列表查不到」。
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

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * 与 `paymentStore()` / `refundStore()` 同一个理由：业务事务的「读—判断—写」
 * 必须发生在同一段没有 `await` 的同步代码里，走 `getNotificationRepository()`
 * 的异步方法做不到。
 */
export function notificationStore(): MockNotificationStore {
  return store();
}

/**
 * **同步**写入一条完整的通知记录，返回写进去的那一条。
 *
 * ⚠️ 必须是同步的（无 `await`）：订单超时退款、订单退回公共池这些业务写入发生在
 * 原子区段内，通知要与它们**同段**写下去。分开写就会出现「订单退了但没通知」——
 * 中间只要有一次请求失败或进程重启（Mock 存储重启即失），用户就永远不知道自己被退了单。
 *
 * ⚠️ 收的是**完整记录**（含 id 与 createdAt），因为调用方要用**它自己那一次业务操作的
 * 时间与 id**，不能让仓储在这里另取一个 `new Date()`：通知的时间与订单的时间
 * 必须是同一个时刻，否则对账时对不上。
 *
 * ⚠️ **这里刻意不校验内容**（空标题、地址边界）。它的调用方是业务事务的原子区段：
 * 在区段里抛错意味着「订单已经退了，但通知没写成，整个请求失败」——留下的是半完成的
 * 业务状态。内容规则统一由服务层的 `parseNotificationInput` 守（那里抛错时什么都还没写）。
 *
 * ⚠️ id 冲突时**覆盖**而不是报错：本方法的调用方都是「一条记录对应一次业务动作」，
 * 重复的 id 只可能来自调用方自己拼错了 id。
 */
export function appendNotification(record: Notification): Notification {
  const current = store();

  // —— 原子区段开始（无 await）——
  current.notifications.set(record.id, record);
  // —— 原子区段结束 ——

  return record;
}

/**
 * 由输入生成一条完整记录（id 与创建时间在这里产生）。
 *
 * ⚠️ 不做校验：内容边界的判定在 `lib/constants/service.ts` 的 `parseNotificationInput`
 * 里，仓储只负责存取。这里再判一次会变成第二套规则。
 */
function buildNotificationRecord(input: NotificationInput): Notification {
  return {
    id: `nt_${crypto.randomUUID()}`,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    body: input.body,
    // 通知的创建时间就是**现在**：它不是用户填的，也没有「补一条过去时间的通知」这种需求
    createdAt: new Date().toISOString(),
    // 新建的通知一定是未读：已读是用户自己读出来的状态，不是创建参数
    readAt: null,
    href: input.href,
  };
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

  async createNotification(input) {
    return appendNotification(buildNotificationRecord(input));
  },
};
