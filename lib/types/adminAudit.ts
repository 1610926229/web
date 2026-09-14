/**
 * 后台操作审计记录的类型。
 *
 * ⚠️ 类型名里的「Admin」是**历史命名**：这张表自 P8C 起记录管理后台的写操作，
 * P8D-2 起**同时记录客服工作台的写操作**，靠 `actorRole` 区分是哪一类账号做的。
 * 名字没有跟着改，是因为它在 21 个文件里被引用，而改名换不来任何实际约束；
 * 动作词表（`AdminAuditAction`）也没有分裂成两套——「发生了什么」不因谁做的而不同，
 * 「是谁做的」由 `actorRole` / `actorId` / `actorName` 三个字段回答。
 *
 * ⚠️ 这张表**只由服务端写入**。没有任何接口能创建、修改或删除审计记录——
 * 用户端、管理端与客服端都没有；本阶段也没有审计页面（见 §十）。
 * 因此「谁能看到审计」这个问题在本阶段甚至还不存在：它只存在于仓储里。
 *
 * ⚠️ **记的是动作，不是内容**：`before` / `after` 是**精简快照**，
 * 只放状态与本次改动涉及的关键字段。收纳规则写在 `lib/constants/adminAudit.ts`，
 * 三条硬边界在那里注释说明：
 * 不存 Cookie / 凭据 / 会话标识，不存完整申请凭证（图片地址、文件名），
 * 不存申请正文与联系说明的全量文本。
 */

import type { ActorRole } from "./actor";

/**
 * 被审计的动作。
 *
 * 取值是**动作**而不是接口路径：「停用」既可能来自 `POST /disable`，
 * 也可能来自 `PATCH` 里把 `enabled` 改成 false，两者记的是同一件事。
 * 反过来，一个接口只记一条——审计的粒度是「发生了一次什么变更」。
 */
export type AdminAuditAction =
  | "application.start-review"
  | "application.approve"
  | "application.reject"
  | "companion.update"
  | "companion.pause"
  | "companion.resume"
  | "companion.enable"
  | "companion.disable"
  | "companion.remove"
  // ————— 商品与类目（P8B）—————
  // 「新建」与「编辑」分开记：新建的 before 是 null，事后从动作名就能看出
  // 「这条记录是这次操作产生的」，不必再去比对 before 是否为 null。
  | "category.create"
  | "category.update"
  | "category.enable"
  | "category.disable"
  | "category.remove"
  | "product.create"
  | "product.update"
  | "product.publish"
  | "product.unpublish"
  | "product.remove"
  // ————— 退款审核与投诉处理（P8C / P8D-2）—————
  // 六个动作，一个不多一个不少：正好是两条状态机上「到了终态的每一步」加一个
  // 「开始看」。**没有 `refund.cancel`**：撤销是用户自己的动作，平台不能替用户撤销，
  // 因此它既不在接口里，也不在审计动作里——审计记的是**平台侧做过什么**。
  //
  // ⚠️ P8D-2 起这张词表**由管理端与客服端共用**，同一个动作名在两侧都会出现，
  // 靠 `actorRole` 区分是谁做的。没有分裂成 `refund.staff-reject` 这类第二套词表的理由：
  // 「退款被拒绝了」这件事只有一种含义，把它按操作者拆成两个动作，
  // 会让「这笔退款被谁拒的」变成一次动作名的字符串比较，而那是 `actorRole` 该回答的问题。
  // ⚠️ 唯一的例外是 `refund.approve`：它会把订单改成 `refunded`（真实资金最终划拨），
  // 因此**只有管理员能产生这条审计**，客服侧的写接口里根本没有这个动作。
  | "refund.start-review"
  | "refund.approve"
  | "refund.reject"
  | "complaint.start-processing"
  | "complaint.resolve"
  | "complaint.close"
  // ————— 客服账号（P8D-1）—————
  // 五个动作对应账号的完整生命周期：新增 / 编辑 / 启用 / 停用 / 移除。
  // 「启用」与「停用」分开记而不是合并成一个 `staff.update`：这两件事的后果不同
  // （停用会让已有 Cookie 立即失效），审计里必须一眼看得出发生的是哪一种。
  // ⚠️ 没有 `staff.login`：登录不是对账号的改动，硬把每次登录塞进审计表
  // 只会让「谁改过账号」淹没在登录记录里；最后登录时间在账号记录上单独有字段。
  | "staff.create"
  | "staff.update"
  | "staff.enable"
  | "staff.disable"
  | "staff.remove";

/** 被操作对象的类型。与 `targetId` 一起指向具体记录。 */
export type AdminAuditTargetType =
  | "companionApplication"
  | "companion"
  | "category"
  | "product"
  | "refund"
  | "complaint"
  /** 客服账号（P8D-1）。`targetId` 是 `StaffAccount.id`，不是用户名 */
  | "staff";

/**
 * 精简快照。
 *
 * 值只允许标量：**没有嵌套对象、没有数组**——这一条限制本身就是防泄漏的手段，
 * 一个字段忘了裁剪也不可能把一个对象整个塞进来。数组类的值（游戏 / 大区 / 标签）
 * 先拼成一个字符串再放进来（见 `lib/constants/adminAudit.ts`）。
 */
export type AdminAuditSnapshot = Record<string, string | number | boolean | null>;

/**
 * 一条审计记录。
 *
 * P8D-2 起「是谁做的」由 `actorId` / `actorRole` / `actorName` 三个字段回答，
 * 而不是原来那一个 `adminId`——它现在同时装得下管理员与客服（见 `lib/types/actor.ts`）。
 */
export type AdminAuditEntry = {
  id: string;
  /**
   * 执行操作的账号 id：`actorRole === "admin"` 时是 `AdminAccount.id`，
   * `actorRole === "customer_service"` 时是 `StaffAccount.id`。
   *
   * ⚠️ **永远由服务端从会话写入**，请求体里的任何同名字段都读不到这里
   * （`writeAudit` 只认 `ctx`，而 `ctx` 由服务层按守卫返回的会话拼装）。
   */
  actorId: string;
  /**
   * 执行操作的账号类型。**这个字段存在的唯一理由**就是让上面那个 id 能被读对：
   * 没有它，`staff-2` 与 `admin-1` 在表里长得完全一样。
   */
  actorRole: ActorRole;
  /**
   * 操作者当时的显示名称快照；取不到时为 null。
   *
   * ⚠️ 客服写入时一定写得出（`requireStaff()` 返回的会话里就有 `displayName`）；
   * 管理端**本阶段一律为 null**，因为管理写操作的入参至今只有一个 `adminId` 字符串，
   * 把 8 个管理服务连同它们的全部接口改成传对象，换来的只是审计表里一个
   * 本阶段没有任何页面会读的字段——那是 §十四 明令不要的扩大范围。
   * 字段先立在这里，将来管理端要记名字时只需改那一处 `writeContext()`。
   */
  actorName: string | null;
  action: AdminAuditAction;
  targetType: AdminAuditTargetType;
  targetId: string;
  /** 变更前快照；创建类动作为 null */
  before: AdminAuditSnapshot | null;
  /** 变更后快照；删除类动作为 null（本阶段没有硬删除，因此实际不为 null） */
  after: AdminAuditSnapshot | null;
  /**
   * 本次操作的稳定标识。
   *
   * 有幂等键的写操作（开始审核 / 通过 / 拒绝 / 停用 / 移除 / 启用 / 暂停接单）
   * **直接用它**：同一个键重复到达时，服务端靠这个索引认出「这件事已经做过了」，
   * 于是既不再写业务数据、也不再写第二条审计。
   * 没有幂等键的写操作（编辑资料）由服务端生成一个 `op_…`。
   */
  operationId: string;
  createdAt: string;
};
