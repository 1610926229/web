/**
 * 「这件事是谁做的」——**全站唯一的操作者取值域**。
 *
 * P8C 之前只有一类人能写业务数据：管理员。因此退款记录上的 `reviewedBy`、
 * 投诉记录上的 `handledByAdminId`、审计表上的 `adminId` 都可以只存一个 id，
 * 「是谁」这个问题不问自明。
 *
 * P8D-2 起客服也能写这两类记录了，于是「一个 id」不再够用：`staff-2` 与 `admin-1`
 * 落在同一个字段里之后，读的人无从判断该怎么称呼它（去客服表查？还是管理表？）。
 * 这个类型就是补上的那一半答案。
 *
 * ⚠️ **只有两个取值，而且刻意只有两个**：
 *
 * - `admin` —— 管理后台的账号（`AdminAccount.id`）；
 * - `customer_service` —— 客服工作台的账号（`StaffAccount.id`）。
 *
 * 普通用户不在取值域里：用户撤销退款申请是自己的动作，平台不会把它记成
 * 「一次平台处理」（§九 的 `refund.cancel` 缺席就是这个意思）。
 *
 * ⚠️ 这个类型**不是权限**。它回答的是「已经发生的事是谁做的」，
 * 而不是「谁可以做」——后者仍然是三个互相独立的 `requireUser` / `requireAdmin` /
 * `requireStaff`，没有任何一处会拿这里的取值去放行请求。
 */
export type ActorRole = "admin" | "customer_service";
