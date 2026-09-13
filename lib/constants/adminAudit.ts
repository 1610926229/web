import type { AdminAuditAction, AdminAuditSnapshot } from "@/lib/types/adminAudit";
import type { CategoryRecord } from "@/lib/types/catalog";
import type { Companion } from "@/lib/types/companion";
import type { CompanionApplication } from "@/lib/types/companionApplication";
import type { CatalogProductRecord } from "@/lib/types/product";
import { listEffectiveSpecs, productDisplayPrice } from "./catalog";

/**
 * 审计动作文案与**精简快照的收纳规则**（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与 `./catalog`（同样是纯函数，无服务端依赖）外没有运行时依赖，
 * node 能直接加载它做纯逻辑测试，客户端组件引用它也不会把服务端模块打进浏览器产物。
 *
 * 这一层存在的唯一理由：**「快照里能放什么」只有一处规定**。
 * 审计写入发生在 `lib/data/adminCompanionTransaction.ts`，如果由那里随手拼字段，
 * 每个动作就会有一套自己的收纳口径，迟早有人把整个实体 `{ ...application }` 放进去
 * ——那等于把申请正文、联系说明、凭证地址、乃至将来可能出现的任何字段一并留档。
 *
 * 四条硬边界（§十），由下面的 builder 保证，并被单元测试盯着：
 *
 * 1. **不存 Cookie / 登录凭据 / 会话标识**：快照里出现的只有业务字段，
 *    写入方拿不到会话，本文件也没有任何读取 Cookie 的位置。
 * 2. **不存完整申请凭证**：不写 `evidence` 数组（地址、文件名一个都不进），
 *    只记一个 `evidenceCount`——「交了几份」够用了，「交了哪几张图」不需要。
 * 3. **不存申请正文与联系说明的全量文本**：`experience` / `introduction` /
 *    `contactNote` 一律不进快照；审核意见经过截断后进（它是审核结果的一部分，
 *    不留下来就说不清「当时为什么拒了」）。
 * 4. **不存后台改不了的统计字段**：销量（`monthlySales`）与平台标签（`gameTag`）
 *    不进商品快照。它们在 before/after 里永远相同，记下来只会留下一份必然过期的
 *    数字副本——而看审计的人无从知道它已经过期了。
 */

export const ADMIN_AUDIT_ACTION_LABELS: Record<AdminAuditAction, string> = {
  "application.start-review": "开始审核入驻申请",
  "application.approve": "通过入驻申请",
  "application.reject": "拒绝入驻申请",
  "companion.update": "编辑护航资料",
  "companion.pause": "暂停接单",
  "companion.resume": "恢复接单",
  "companion.enable": "启用护航",
  "companion.disable": "停用护航",
  "companion.remove": "移除护航",
  // ————— 商品与类目（P8B）—————
  "category.create": "新建类目",
  "category.update": "编辑类目",
  "category.enable": "启用类目",
  "category.disable": "停用类目",
  "category.remove": "移除类目",
  "product.create": "新建商品",
  "product.update": "编辑商品",
  "product.publish": "上架商品",
  "product.unpublish": "下架商品",
  "product.remove": "移除商品",
};

export function adminAuditActionLabel(action: AdminAuditAction): string {
  return ADMIN_AUDIT_ACTION_LABELS[action];
}

/** 快照里任何一段自由文本的截断长度。超过就截断加省略号。 */
export const ADMIN_AUDIT_TEXT_MAX_LENGTH = 60;

/** 审核意见的截断长度。与上面的通用长度分开，是因为它出现在页面上时单独一行。 */
export const ADMIN_AUDIT_REVIEW_NOTE_MAX_LENGTH = 60;

const ELLIPSIS = "…";

/**
 * 截断到指定字符数。
 *
 * 用 `Array.from` 而不是 `slice`：全站的字数口径都是 code point
 * （见 `lib/utils/text.ts`），用 `slice` 会把一个 emoji 切成两半。
 */
export function truncateAuditText(raw: string, max = ADMIN_AUDIT_TEXT_MAX_LENGTH): string {
  const value = raw.trim();
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  return `${characters.slice(0, max).join("")}${ELLIPSIS}`;
}

/** 数组类字段（游戏 / 大区 / 标签）先拼成字符串：快照里只允许标量。 */
function joinAuditList(values: readonly string[]): string {
  return values.join("、");
}

/**
 * 入驻申请的精简快照。
 *
 * ⚠️ 刻意**没有** `contactNote`（联系说明）、`experience` / `introduction`（正文）、
 * `evidence`（凭证数组）。新增申请字段时也不会自动进快照——这里显式列举字段，
 * 与 DTO 的做法一致：只有写在这里的字段才会被留档。
 */
export function toCompanionApplicationAuditSnapshot(
  application: CompanionApplication,
): AdminAuditSnapshot {
  return {
    status: application.status,
    applicationNo: application.applicationNo,
    displayName: application.displayName,
    games: joinAuditList(application.gameIds),
    regions: joinAuditList(application.regions),
    reviewedAt: application.reviewedAt,
    reviewNote: truncateAuditText(application.reviewNote, ADMIN_AUDIT_REVIEW_NOTE_MAX_LENGTH),
    evidenceCount: application.evidence.length,
  };
}

/**
 * 护航资料的精简快照。
 *
 * 这里**保留 `userId`**：审计要能回答「这条护航是谁的」，而 §七 的整个保证
 * 就是「一名用户最多一条有效护航」。审计记录只存在于服务端仓储里，本阶段
 * 没有任何接口能读到它（§十：本阶段不做审计页面），因此这个字段不会外泄；
 * 将来真要做审计页面，也应当先在那一层决定给谁看，而不是先把关联关系丢掉。
 *
 * 统计字段（`completedOrderCount` / `rating` / `tipsCount` / `reviewCount`）
 * 一个都不进快照：它们**不可由后台修改**（§八），也就永远不会出现在 before/after 的差异里，
 * 记下来只是徒增一份会过期的数字副本。
 */
export function toCompanionAuditSnapshot(companion: Companion): AdminAuditSnapshot {
  return {
    userId: companion.userId,
    applicationId: companion.applicationId,
    displayName: companion.displayName,
    avatarUrl: companion.avatarUrl,
    intro: truncateAuditText(companion.intro),
    games: joinAuditList(companion.gameIds),
    regions: joinAuditList(companion.regions),
    serviceTags: joinAuditList(companion.serviceTags),
    enabled: companion.enabled,
    available: companion.available,
    unavailableReason: companion.unavailableReason,
    sortOrder: companion.sortOrder,
    removedAt: companion.removedAt,
  };
}

/**
 * 类目的精简快照。
 *
 * 六个字段就是这条记录**全部可被后台改动的东西**，因此 before/after 的差异
 * 恰好说明了这次操作改了什么。`createdAt` 不进快照：它永远不变，
 * 放进每一条审计里只是把一个常量抄了很多遍。
 */
export function toCategoryAuditSnapshot(record: CategoryRecord): AdminAuditSnapshot {
  return {
    gameId: record.gameId,
    name: record.name,
    sortOrder: record.sortOrder,
    enabled: record.enabled,
    removedAt: record.removedAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 商品的精简快照。
 *
 * ⚠️ 刻意**没有** `monthlySales`（销量）与 `gameTag`：这两个字段后台改不了（§八），
 * 因此永远不会出现在 before/after 的差异里。把一份统计数字抄进审计，只会得到
 * 一个当时正确、之后必然过期的副本——而且看的人无从知道它已经过期了。
 *
 * 规格不进完整的 before/after 明细，只留三个标量：`specCount`（全部）、
 * `effectiveSpecCount`（有效）与 `specNames`（截断后的名字串）。审计要回答的是
 * 「这次改价动了哪几条规格」，不是把整份规格表留档——真需要精确明细时，
 * 商品记录本身与订单快照都还在。
 */
export function toProductAuditSnapshot(record: CatalogProductRecord): AdminAuditSnapshot {
  return {
    title: record.title,
    gameId: record.gameId,
    categoryId: record.categoryId,
    status: record.status,
    recommended: record.recommended,
    sortOrder: record.sortOrder,
    tags: joinAuditList(record.tags),
    detailText: truncateAuditText(record.detailText),
    detailImageCount: record.detailImages.length,
    specCount: record.specs.length,
    effectiveSpecCount: listEffectiveSpecs(record).length,
    specNames: truncateAuditText(record.specs.map((spec) => spec.name).join("、")),
    priceFrom: productDisplayPrice(record),
    removedAt: record.removedAt,
    updatedAt: record.updatedAt,
  };
}
