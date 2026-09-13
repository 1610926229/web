/**
 * 管理操作审计记录的类型。
 *
 * ⚠️ 这张表**只由服务端写入**，而且只在管理写操作里写。没有任何接口能创建、
 * 修改或删除审计记录——用户端与管理端都没有；本阶段也没有审计页面（见 §十）。
 * 因此「谁能看到审计」这个问题在本阶段甚至还不存在：它只存在于仓储里。
 *
 * ⚠️ **记的是动作，不是内容**：`before` / `after` 是**精简快照**，
 * 只放状态与本次改动涉及的关键字段。收纳规则写在 `lib/constants/adminAudit.ts`，
 * 三条硬边界在那里注释说明：
 * 不存 Cookie / 凭据 / 会话标识，不存完整申请凭证（图片地址、文件名），
 * 不存申请正文与联系说明的全量文本。
 */

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
  | "product.remove";

/** 被操作对象的类型。与 `targetId` 一起指向具体记录。 */
export type AdminAuditTargetType =
  | "companionApplication"
  | "companion"
  | "category"
  | "product";

/**
 * 精简快照。
 *
 * 值只允许标量：**没有嵌套对象、没有数组**——这一条限制本身就是防泄漏的手段，
 * 一个字段忘了裁剪也不可能把一个对象整个塞进来。数组类的值（游戏 / 大区 / 标签）
 * 先拼成一个字符串再放进来（见 `lib/constants/adminAudit.ts`）。
 */
export type AdminAuditSnapshot = Record<string, string | number | boolean | null>;

/** 一条审计记录。字段就是 §十 列出的那九个，不多不少。 */
export type AdminAuditEntry = {
  id: string;
  /** 执行操作的管理者 id（`AdminAccount.id`），不是用户名也不是会话标识 */
  adminId: string;
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
