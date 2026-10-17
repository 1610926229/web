import type { NotificationInput } from "@/lib/types/notification";
import type { NotificationRepository } from "../notificationRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
// ⚠️ `notifications` 的列清单与行 → 领域对象映射从 `w1Rows.ts` 取，**不在这里再写一份**：
// 本轮接单 / 退款事务（`w1Transactions.ts`）也要插这张表。
import { NOTIFICATION_COLUMNS as COLUMNS, toNotification, type NotificationRow } from "./w1Rows";

/**
 * `NotificationRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/notificationRepository.ts` 里的接口一个字没改，
 * 上层服务层、路由、页面都不知道底下换了一个存储。
 *
 * ## 为什么这里没有幂等键
 *
 * `notifications` 表刻意没有 `dedupe_key` 列（见 `db/migrations/0006_settlement.sql`）。
 * 通知不是用户提交的表单，请求重放问题在业务侧（订单超时退款本身就是幂等的，重复触发
 * 不会再退一次），因此 `createNotification` 只保证「一条输入进去、一条记录出来」。
 * id 由写入方生成、主键即「冲突就报错、拒绝覆盖」——这与 Mock 的
 * `appendNotification` 遇到已存在 id 时抛错**一字不差**，绝不静默覆盖一条业务事实。
 *
 * ⚠️ 真正需要与业务写入**同段完成**的调用方（原子区段里不允许 `await`）在 Mock 侧用的是
 * **同步**写入器 `appendNotification`，而不是本方法——那种场景属于事务层，不在本文件。
 * 本文件只翻译 `NotificationRepository` 接口上的四个方法。
 *
 * ## 时间
 *
 * `created_at` / `read_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成 ISO 字符串
 * 或 null，因此领域对象里仍是 `string`，与 Mock 一致。
 */

/**
 * 用任意可执行 SQL 的对象造一个通知仓储。
 *
 * 与收藏 / 反馈同构：**一个工厂同时产出普通仓储与事务内仓储**，接口完全相同。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让通知与同一事务里的业务写入
 * 共享同一个提交点（将来订单超时退款把通知写进 PG 事务时正需要这一点）。
 */
export function createNotificationRepository(db: PgQueryable): NotificationRepository {
  return {
    async listNotifications(userId) {
      // 接口约定「排序由服务层决定、仓储只取全量」；Mock 也不排序。
      // 但 SQL 的未排序结果是**不确定**的，因此补一个与
      // `compareNotificationsNewestFirst` 同向的全序（`created_at DESC, id DESC`）：
      // 它不会被服务层的再次排序覆盖成不同答案，只是让结果本身可复现。
      const rows = await db.query<NotificationRow>(
        `SELECT ${COLUMNS} FROM notifications WHERE user_id = $1
          ORDER BY created_at DESC, id DESC`,
        [userId],
      );
      return rows.map(toNotification);
    },

    async findNotificationById(id) {
      const rows = await db.query<NotificationRow>(
        `SELECT ${COLUMNS} FROM notifications WHERE id = $1`,
        [id],
      );
      return rows[0] ? toNotification(rows[0]) : null;
    },

    async markNotificationRead(id, userId, readAt) {
      // 一条语句完成「归属校验 + 幂等写入」：`WHERE id = $1 AND user_id = $2 AND read_at IS NULL`
      // 同时挡住三种情况——不存在、不属于你、已经读过——它们都不会改到行。
      // 已读时间只写一次：重复标记不会把「什么时候读的」刷新成现在（`read_at IS NULL` 就是这条规则）。
      const updated = await db.query<NotificationRow>(
        `UPDATE notifications
            SET read_at = $3
          WHERE id = $1 AND user_id = $2 AND read_at IS NULL
          RETURNING ${COLUMNS}`,
        [id, userId, readAt],
      );
      if (updated[0]) return toNotification(updated[0]);

      // 没改到行时再读一次，区分「不属于你 / 不存在」（null）与「已经读过」（返回既有记录）。
      // 不存在与不属于你表现完全一致：无法用接口枚举别人的通知 id。
      const existing = await db.query<NotificationRow>(
        `SELECT ${COLUMNS} FROM notifications WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      return existing[0] ? toNotification(existing[0]) : null;
    },

    async createNotification(input: NotificationInput) {
      // id 与 Mock 的 `newNotificationId()` 同一形状（`nt_` + UUIDv4）。
      // 唯一性由主键保证：`INSERT` 不带 `ON CONFLICT`，撞车即报错、不覆盖——
      // 这正是 `appendNotification` 的既有行为。撞车概率极低，但「极低」不是零，
      // 而一条已有的通知是业务事实，不能被新记录顶掉。
      const id = `nt_${crypto.randomUUID()}`;

      // `created_at` 用数据库的 `now()`：通知的创建时间就是**现在**，
      // 且随 `RETURNING` 经 `pool.ts` 还原成 ISO 字符串，仓储不自己取墙钟。
      // 新建通知一定是未读：已读是用户自己读出来的状态，不是创建参数（`read_at` 恒为 NULL）。
      const rows = await db.query<NotificationRow>(
        `INSERT INTO notifications (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, now(), NULL, $7)
         RETURNING ${COLUMNS}`,
        [id, input.userId, input.kind, input.title, input.summary, input.body, input.href],
      );
      return toNotification(rows[0]);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgNotificationRepository: NotificationRepository =
  createNotificationRepository(lazyPgExecutor());
