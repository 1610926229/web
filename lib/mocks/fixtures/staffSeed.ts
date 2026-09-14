import type { StaffAccount } from "@/lib/types/staff";
import { getMockSeedNow } from "./mockClock";

/**
 * 客服账号的预置数据（**Mock**）。
 *
 * ⚠️ 这里**没有密码、没有密钥、没有任何凭据**——本阶段的登录是一个模拟入口，
 * 不给任何人输入账号密码的地方，也就没有可以泄漏、可以撞库、可以提交进仓库的东西。
 * 真实客服账号体系（含密码与找回）属于后续阶段。
 *
 * ⚠️ 这份数据与 `userSeed` / `adminSeed` **没有任何对应关系**：
 * 同一个字符串在这一份里是客服、在另外两份里查不到，反之亦然。
 * 三边不共享 id、不互相查询，因此「拿用户 Cookie 或管理 Cookie 换客服身份」
 * 在数据层就没有可以走的路径。
 *
 * ⚠️ 客服账号**不进消费排行榜**：榜单读的是用户仓储（`userRepository.listUsers()`），
 * 与这份数据没有交集。这不是靠页面记得过滤，而是靠数据来源不同。
 *
 * 五个账号覆盖客服端的全部结局，每一条都对应一条必须被验证的规则：
 *
 * | id | 角色 | 状态 | 验证什么 |
 * |----|------|------|----------|
 * | `staff-1` | 客服 | 启用 | 正常登录、发消息、标记已读；预置历史消息的发送者 |
 * | `staff-2` | 客服 | 启用 | 「另一个客服」：已读状态互不影响 |
 * | `staff-3` | 客服 | 停用 | 停用后登录被拒、已有会话立即失效 |
 * | `staff-4` | **护航** | 启用 | 非客服角色进不了工作台（403） |
 * | `staff-5` | 客服 | **已移除** | 软删除后登录被拒、后台仍查得到、历史消息快照仍可显示 |
 *
 * `lastLoginAt` 只给 `staff-1` 一条：既能看到「有登录记录」的样子，
 * 也能看到「从未登录」的占位，不必自己去造。
 */
const now = getMockSeedNow();

/** 相对基准时间的「n 分钟前」。与订单 / 榜单预置数据同一套相对时间写法。 */
function minutesAgo(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

const ACCOUNT_CREATED_AT = minutesAgo(60 * 24 * 30);

export const staffSeed: readonly StaffAccount[] = [
  {
    id: "staff-1",
    username: "kefu-xiaoyu",
    displayName: "客服小雨（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    role: "customer_service",
    enabled: true,
    createdAt: ACCOUNT_CREATED_AT,
    updatedAt: ACCOUNT_CREATED_AT,
    lastLoginAt: minutesAgo(35),
    removedAt: null,
  },
  {
    id: "staff-2",
    username: "kefu-anran",
    displayName: "客服安然（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    role: "customer_service",
    enabled: true,
    createdAt: ACCOUNT_CREATED_AT,
    updatedAt: ACCOUNT_CREATED_AT,
    lastLoginAt: null,
    removedAt: null,
  },
  {
    id: "staff-3",
    username: "kefu-linlin",
    displayName: "客服琳琳（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    role: "customer_service",
    enabled: false,
    createdAt: ACCOUNT_CREATED_AT,
    updatedAt: minutesAgo(60 * 20),
    lastLoginAt: minutesAgo(60 * 48),
    removedAt: null,
  },
  {
    id: "staff-4",
    username: "huhang-aze",
    displayName: "护航阿泽（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    role: "companion",
    enabled: true,
    createdAt: ACCOUNT_CREATED_AT,
    updatedAt: ACCOUNT_CREATED_AT,
    lastLoginAt: null,
    removedAt: null,
  },
  {
    id: "staff-5",
    username: "kefu-yiqi",
    displayName: "已移除的客服（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    role: "customer_service",
    enabled: false,
    createdAt: ACCOUNT_CREATED_AT,
    updatedAt: minutesAgo(60 * 6),
    lastLoginAt: minutesAgo(60 * 40),
    removedAt: minutesAgo(60 * 6),
  },
];

/**
 * 预置聊天记录里客服消息的发送者。
 *
 * 指向**真实存在的预置客服账号**（而不是一个凭空写的 `support-01`）：
 * 这样「停用 / 移除一个客服之后，他发过的历史消息仍然显示当时的名字与头像」
 * 才有真实数据可以验收——去后台把 `staff-1` 停掉，再打开那几笔订单的沟通记录。
 */
export const PRESET_STAFF_SENDER_ID = "staff-1";
