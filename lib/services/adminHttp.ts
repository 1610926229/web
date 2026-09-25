import { apiGet, apiPatch, apiPost } from "@/lib/api/client";
import {
  ADMIN_APPLICATION_PAGE_SIZE,
  type AdminApplicationStatusFilter,
} from "@/lib/constants/adminApplications";
import {
  type AdminCatalogRemovalFilter,
  type AdminEnabledFilter,
  type AdminRecommendedFilter,
  type AdminStatusFilter,
} from "@/lib/constants/adminCatalog";
import { ADMIN_CATEGORY_PAGE_SIZE } from "@/lib/constants/adminCategories";
import {
  ADMIN_COMPLAINT_PAGE_SIZE,
  type AdminComplaintStatusFilter,
  type AdminComplaintTypeFilter,
} from "@/lib/constants/adminComplaints";
import type { ContentRemovalFilter } from "@/lib/constants/adminContent";
import {
  ADMIN_STAFF_PAGE_SIZE,
  type AdminStaffProfileInput,
  type AdminStaffStateFilter,
} from "@/lib/constants/adminStaff";
import { ADMIN_ORDER_PAGE_SIZE, type AdminOrderStatusFilter } from "@/lib/constants/adminOrders";
import {
  ADMIN_REFUND_PAGE_SIZE,
  type AdminRefundStatusFilter,
} from "@/lib/constants/adminRefunds";
import {
  ADMIN_COMPANION_PAGE_SIZE,
  type AdminCompanionRemovalFilter,
  type AdminCompanionStateFilter,
} from "@/lib/constants/adminCompanions";
import { ADMIN_PRODUCT_PAGE_SIZE } from "@/lib/constants/adminProducts";
import type { AdminLoginResult, AdminSessionUser } from "@/lib/types/admin";
import type {
  AdminCategoryListData,
  AdminCategoryListItem,
  AdminCategoryProfilePatch,
  AdminCategoryWriteResult,
} from "@/lib/types/catalog";
import type {
  AdminProductListData,
  AdminProductListItem,
  AdminProductWriteResult,
  ProductProfilePatch,
} from "@/lib/types/product";
import type {
  AdminCompanionDetail,
  AdminCompanionListData,
  AdminCompanionProfilePatch,
  AdminCompanionWriteResult,
} from "@/lib/types/companion";
import type {
  AdminApplicationListData,
  AdminApplicationReviewResult,
  AdminCompanionApplicationDetail,
} from "@/lib/types/companionApplication";
import type {
  AdminComplaintDetail,
  AdminComplaintListData,
  AdminComplaintWriteResult,
} from "@/lib/types/complaint";
import type { AdminOrderDetail, AdminOrderListData } from "@/lib/types/order";
import type {
  AdminPlatformConfigPatch,
  AdminPlatformConfigWriteResult,
  PlatformConfig,
} from "@/lib/types/platformConfig";
import type {
  AdminRefundDetail,
  AdminRefundListData,
  AdminRefundWriteResult,
} from "@/lib/types/refund";
import type { AdminStaffDetail, AdminStaffListData, AdminStaffWriteResult } from "@/lib/types/staff";
import type {
  AdminAgreementDetail,
  AdminAgreementListData,
  AdminAgreementProfilePatch,
  AdminAgreementWriteResult,
} from "@/lib/types/agreement";
import type {
  AdminAnnouncementItem,
  AdminAnnouncementProfilePatch,
  AdminBannerItem,
  AdminBannerProfilePatch,
  AdminContentList,
  AdminQuickEntryItem,
  AdminQuickEntryProfilePatch,
} from "@/lib/types/content";

/**
 * 管理端的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/adminAuth.ts` / `adminCompanionApplications.ts` /
 * `adminCompanions.ts` 分开是必须的：那些模块依赖 `lib/data` 与 `lib/mocks`，
 * 一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 *
 * 本文件只做三件事，多一件都不做：拼地址、把请求发出去、把响应按 DTO 类型返回。
 * **没有任何权限判断、没有任何业务规则**——它们都在服务端：
 * 界面上藏起一个按钮不是权限，接口该 401 还是 401、该 403 还是 403。
 *
 * ⚠️ 本文件**不读也不写任何 Cookie**：会话由服务端下发 HttpOnly Cookie 维护，
 * 客户端连「我是谁」都不自己存一份。管理端身份因此不存在于任何页面状态里。
 *
 * ⚠️ 所有写接口都带 `idempotencyKey`，且由**调用方**生成（同一次用户意图内保持不变）。
 * 按钮禁用只能挡住手快，真正的防重在服务端按这个键做重放判定（§九）。
 */

// ——————————————————————————— 会话 ———————————————————————————

/** 当前管理端会话；未登录或没有权限时抛 401 / 403。 */
export function fetchAdminSession(): Promise<AdminSessionUser> {
  return apiGet<AdminSessionUser>("/api/admin/auth/session");
}

/** 模拟管理员登录。不传任何身份信息，登录对象由服务端固定。 */
export function mockLoginAdmin(): Promise<AdminLoginResult> {
  return apiPost<AdminLoginResult>("/api/admin/auth/mock-login");
}

/** 退出登录：服务端删除管理端 Cookie。 */
export function logoutAdmin(): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>("/api/admin/auth/logout");
}

// ——————————————————————————— 入驻审核 ———————————————————————————

export type AdminApplicationListRequest = {
  status?: AdminApplicationStatusFilter;
  keyword?: string;
  /** 空串表示全部游戏 */
  gameId?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 取一页入驻申请。
 *
 * 只有**筛选与分页**参数，没有任何用户标识：审核人是谁由服务端会话决定，
 * 不由调用方声明。空值不写进地址栏（`?keyword=&gameId=` 只会让日志更难读）。
 */
export function fetchAdminApplications(
  input: AdminApplicationListRequest = {},
): Promise<AdminApplicationListData> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.gameId) params.set("gameId", input.gameId);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_APPLICATION_PAGE_SIZE));

  return apiGet<AdminApplicationListData>(`/api/admin/companion-applications?${params.toString()}`);
}

/** 取一条申请的详情（含正文、凭证、申请人摘要与服务端判定的可执行动作）。 */
export function fetchAdminApplication(id: string): Promise<AdminCompanionApplicationDetail> {
  return apiGet<AdminCompanionApplicationDetail>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}`,
  );
}

/**
 * 三个审核动作。都是 POST，请求体只有幂等键（拒绝另加审核意见）。
 *
 * ⚠️ 三个动作是**三个接口**，不是一个「把状态改成 X」的接口：通过会真的建出护航资料
 * 并发放资格，与「开始审核」这种只改一个状态的动作用途完全不同，
 * 合成一个接口就会出现「点错按钮直接把申请通过了」这种不可撤销的后果。
 */
export function startReviewApplication(
  id: string,
  idempotencyKey: string,
): Promise<AdminApplicationReviewResult> {
  return apiPost<AdminApplicationReviewResult>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}/start-review`,
    { idempotencyKey },
  );
}

export function approveApplication(
  id: string,
  idempotencyKey: string,
): Promise<AdminApplicationReviewResult> {
  return apiPost<AdminApplicationReviewResult>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}/approve`,
    { idempotencyKey },
  );
}

export function rejectApplication(
  id: string,
  idempotencyKey: string,
  reviewNote: string,
): Promise<AdminApplicationReviewResult> {
  return apiPost<AdminApplicationReviewResult>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}/reject`,
    { idempotencyKey, reviewNote },
  );
}

// ——————————————————————————— 护航管理 ———————————————————————————

export type AdminCompanionListRequest = {
  keyword?: string;
  /** 空串表示全部游戏 */
  gameId?: string;
  state?: AdminCompanionStateFilter;
  removal?: AdminCompanionRemovalFilter;
  page?: number;
  pageSize?: number;
};

/** 取一页护航名单（含已停用与已移除的记录，公开接口看不到后者）。 */
export function fetchAdminCompanions(
  input: AdminCompanionListRequest = {},
): Promise<AdminCompanionListData> {
  const params = new URLSearchParams();
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.gameId) params.set("gameId", input.gameId);
  if (input.state) params.set("state", input.state);
  if (input.removal) params.set("removal", input.removal);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_COMPANION_PAGE_SIZE));

  return apiGet<AdminCompanionListData>(`/api/admin/companions?${params.toString()}`);
}

/** 取一条护航详情。**已移除的记录照样返回**：后台要能查到「这个人被移除过」。 */
export function fetchAdminCompanion(id: string): Promise<AdminCompanionDetail> {
  return apiGet<AdminCompanionDetail>(`/api/admin/companions/${encodeURIComponent(id)}`);
}

/**
 * 编辑护航资料。
 *
 * 请求体是**整份白名单**（§八）：昵称、头像、介绍、游戏、大区、服务标签、
 * 启用状态、可接单状态、不可接单原因、展示排序。统计、关联用户、来源申请、
 * 移除时间**没有可传的位置**——多传一个字段服务端也不会读。
 */
export function saveCompanionProfile(
  id: string,
  idempotencyKey: string,
  patch: AdminCompanionProfilePatch,
): Promise<AdminCompanionWriteResult> {
  return apiPatch<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}`, {
    idempotencyKey,
    ...patch,
  });
}

/**
 * 四个接单状态动作与移除。
 *
 * ⚠️ 走的是**窄写入**接口（只改状态字段），不是把资料整份写回去：
 * 「暂停接单」不该顺带把昵称、介绍、排序覆盖成按钮渲染时的旧值。
 *
 * 暂停需要给出原因（§八：不可接单必须有原因），其余动作的原因由服务端按规则处理。
 */
export function pauseCompanion(
  id: string,
  idempotencyKey: string,
  unavailableReason: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/pause`, {
    idempotencyKey,
    unavailableReason,
  });
}

export function resumeCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/resume`, {
    idempotencyKey,
  });
}

export function enableCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/enable`, {
    idempotencyKey,
  });
}

export function disableCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(
    `/api/admin/companions/${encodeURIComponent(id)}/disable`,
    { idempotencyKey },
  );
}

export function removeCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/remove`, {
    idempotencyKey,
  });
}

// ——————————————————————————— 类目管理 ———————————————————————————

export type AdminCategoryListRequest = {
  keyword?: string;
  /** 空串表示全部游戏 */
  gameId?: string;
  enabled?: AdminEnabledFilter;
  removal?: AdminCatalogRemovalFilter;
  page?: number;
  pageSize?: number;
};

/**
 * 取一页类目（含已停用与已移除——后台要能回查自己改过什么）。
 *
 * 只有筛选与分页参数：**没有任何身份信息**。调用方是谁由服务端会话决定，
 * 不由地址栏声明（§九：客户端伪造字段必须被忽略）。
 */
export function fetchAdminCategories(
  input: AdminCategoryListRequest = {},
): Promise<AdminCategoryListData> {
  const params = new URLSearchParams();
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.gameId) params.set("gameId", input.gameId);
  if (input.enabled) params.set("enabled", input.enabled);
  if (input.removal) params.set("removal", input.removal);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_CATEGORY_PAGE_SIZE));

  return apiGet<AdminCategoryListData>(`/api/admin/categories?${params.toString()}`);
}

/** 取一条类目详情。**已移除的类目照样返回**：后台要能查到「这条类目被移除过」。 */
export function fetchAdminCategory(id: string): Promise<AdminCategoryListItem> {
  return apiGet<AdminCategoryListItem>(`/api/admin/categories/${encodeURIComponent(id)}`);
}

/**
 * 新建 / 编辑类目。
 *
 * 请求体是**整份白名单**：所属游戏、名称、排序、启用状态。
 * `removedAt`、`createdAt`、`updatedAt`、`id` **没有可传的位置**——
 * 一次普通保存因此永远无法把一条已移除的类目改回未移除。
 */
export function saveCategoryProfile(
  id: string,
  idempotencyKey: string,
  patch: AdminCategoryProfilePatch,
): Promise<AdminCategoryWriteResult> {
  return apiPatch<AdminCategoryWriteResult>(`/api/admin/categories/${encodeURIComponent(id)}`, {
    idempotencyKey,
    ...patch,
  });
}

export function createCategory(
  idempotencyKey: string,
  patch: AdminCategoryProfilePatch,
): Promise<AdminCategoryWriteResult> {
  return apiPost<AdminCategoryWriteResult>("/api/admin/categories", {
    idempotencyKey,
    ...patch,
  });
}

/**
 * 启用 / 停用 / 移除，三个**窄写入**接口。
 *
 * ⚠️ 不是一个「把 enabled 改成 X」的接口：停用是「暂时不卖这一类」，
 * 移除是「这一类不再存在」，两者的二次确认文案、后果与能否撤销都不同，
 * 合成一个接口就会出现「点错按钮直接把类目移除掉」这种不可撤销的后果。
 *
 * ⚠️ 都是 `POST` + 幂等键：重复点击不会产生第二条审计，也不会刷新移除时间。
 */
export function enableCategory(
  id: string,
  idempotencyKey: string,
): Promise<AdminCategoryWriteResult> {
  return apiPost<AdminCategoryWriteResult>(
    `/api/admin/categories/${encodeURIComponent(id)}/enable`,
    { idempotencyKey },
  );
}

export function disableCategory(
  id: string,
  idempotencyKey: string,
): Promise<AdminCategoryWriteResult> {
  return apiPost<AdminCategoryWriteResult>(
    `/api/admin/categories/${encodeURIComponent(id)}/disable`,
    { idempotencyKey },
  );
}

/** 移除类目（软删除）。类目下还有未移除的商品时服务端会 400 拒绝。 */
export function removeCategory(
  id: string,
  idempotencyKey: string,
): Promise<AdminCategoryWriteResult> {
  return apiPost<AdminCategoryWriteResult>(
    `/api/admin/categories/${encodeURIComponent(id)}/remove`,
    { idempotencyKey },
  );
}

// ——————————————————————————— 商品管理 ———————————————————————————

export type AdminProductListRequest = {
  keyword?: string;
  /** 空串表示全部游戏 */
  gameId?: string;
  /** 空串表示全部类目 */
  categoryId?: string;
  status?: AdminStatusFilter;
  recommended?: AdminRecommendedFilter;
  removal?: AdminCatalogRemovalFilter;
  page?: number;
  pageSize?: number;
};

/** 取一页商品（含已下架与已移除——后台要能回查自己改过什么）。 */
export function fetchAdminProducts(
  input: AdminProductListRequest = {},
): Promise<AdminProductListData> {
  const params = new URLSearchParams();
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.gameId) params.set("gameId", input.gameId);
  if (input.categoryId) params.set("categoryId", input.categoryId);
  if (input.status) params.set("status", input.status);
  if (input.recommended) params.set("recommended", input.recommended);
  if (input.removal) params.set("removal", input.removal);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_PRODUCT_PAGE_SIZE));

  return apiGet<AdminProductListData>(`/api/admin/products?${params.toString()}`);
}

/** 取一条商品详情（含规格数组，**包含已停用与已移除的规格**）。 */
export function fetchAdminProduct(id: string): Promise<AdminProductListItem> {
  return apiGet<AdminProductListItem>(`/api/admin/products/${encodeURIComponent(id)}`);
}

/**
 * 新建 / 编辑商品与它的全部规格（服务端**一次原子写入**）。
 *
 * ⚠️ 价格在这一层仍然是「元」文本：`ProductProfilePatch` 里的规格行带的是
 * `priceYuan`，转成整数分由服务端做（`toProductDraft()` → `parsePriceYuanToFen()`）。
 * 客户端**没有任何机会**直接提交「分」——否则一个前端浮点误差就能把 0.1 元写成 9 分。
 *
 * 这一点由类型本身保证：`ProductProfilePatch.specs` 是 `ProductSpecInput[]`，
 * 里面根本没有一个叫 `price` 的字段。服务端再按 `priceYuan` 读回同一份文本，
 * 两边读写的键逐个对得上。
 *
 * ⚠️ 规格行的 `id`：已存在的规格必须原样带回（它承载身份），
 * 新行传空串由服务端签发。**数组下标不是身份**，因此调换顺序只会改
 * `sortOrder`，不会把别人的价格挪到另一行上。
 */
export function createProduct(
  idempotencyKey: string,
  patch: ProductProfilePatch,
): Promise<AdminProductWriteResult> {
  return apiPost<AdminProductWriteResult>("/api/admin/products", {
    idempotencyKey,
    ...patch,
  });
}

export function saveProductProfile(
  id: string,
  idempotencyKey: string,
  patch: ProductProfilePatch,
): Promise<AdminProductWriteResult> {
  return apiPatch<AdminProductWriteResult>(`/api/admin/products/${encodeURIComponent(id)}`, {
    idempotencyKey,
    ...patch,
  });
}

/**
 * 上架 / 下架 / 移除，三个**窄写入**接口。
 *
 * ⚠️ 与 `saveProductProfile()` 分开：列表上的上下架按钮只应当改状态，
 * 而不是「读出整条商品、拼一个完整 patch 再写回去」——后者会在两位管理员同时操作时，
 * 用后写的那次把另一位刚改好的价格覆盖回旧值。
 *
 * ⚠️ **下架不是移除**：下架后直链仍然可打开并显示「已下架」（`/product/p-off-1`），
 * 只是不能结算；移除才是软删除（直链 404、不进首页与分类页）。
 * 两个动作在界面上是两个按钮、两段不同的二次确认文案。
 */
export function publishProduct(
  id: string,
  idempotencyKey: string,
): Promise<AdminProductWriteResult> {
  return apiPost<AdminProductWriteResult>(`/api/admin/products/${encodeURIComponent(id)}/publish`, {
    idempotencyKey,
  });
}

export function unpublishProduct(
  id: string,
  idempotencyKey: string,
): Promise<AdminProductWriteResult> {
  return apiPost<AdminProductWriteResult>(
    `/api/admin/products/${encodeURIComponent(id)}/unpublish`,
    { idempotencyKey },
  );
}

/** 移除商品（软删除）。历史订单与历史收藏都保留，只是用户端不再可见。 */
export function removeProduct(
  id: string,
  idempotencyKey: string,
): Promise<AdminProductWriteResult> {
  return apiPost<AdminProductWriteResult>(`/api/admin/products/${encodeURIComponent(id)}/remove`, {
    idempotencyKey,
  });
}

// ——————————————————————————— 全量订单（P8C） ———————————————————————————

export type AdminOrderListRequest = {
  status?: AdminOrderStatusFilter;
  keyword?: string;
  /** 游戏名快照；空串表示全部游戏 */
  game?: string;
  /** 起始日期 `YYYY-MM-DD`（含当天）；空串表示不限 */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 取一页全量订单。
 *
 * 只有**筛选与分页**参数，没有任何用户标识：这些订单属于谁由服务端按订单记录给出，
 * 访问资格由服务端会话决定。空值不写进地址栏（`?keyword=&game=` 只会让日志更难读）。
 */
export function fetchAdminOrders(
  input: AdminOrderListRequest = {},
): Promise<AdminOrderListData> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.game) params.set("game", input.game);
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_ORDER_PAGE_SIZE));

  return apiGet<AdminOrderListData>(`/api/admin/orders?${params.toString()}`);
}

/**
 * 取一条订单详情（含游戏账号、备注、金额明细、时间轴与四份售后摘要）。
 *
 * ⚠️ **只有 GET**：本阶段订单详情是只读的，因此这里没有任何「改订单」的函数。
 * 订单唯一会被后台改动的路径是退款审核通过，而那个动作属于退款申请。
 */
export function fetchAdminOrder(id: string): Promise<AdminOrderDetail> {
  return apiGet<AdminOrderDetail>(`/api/admin/orders/${encodeURIComponent(id)}`);
}

// ——————————————————————————— 退款审核（P8C） ———————————————————————————

export type AdminRefundListRequest = {
  status?: AdminRefundStatusFilter;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

/** 取一页退款申请。 */
export function fetchAdminRefunds(
  input: AdminRefundListRequest = {},
): Promise<AdminRefundListData> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.keyword) params.set("keyword", input.keyword);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_REFUND_PAGE_SIZE));

  return apiGet<AdminRefundListData>(`/api/admin/refunds?${params.toString()}`);
}

/** 取一条退款申请详情（含原因、说明、凭证、审核信息与服务端判定的可执行动作）。 */
export function fetchAdminRefund(id: string): Promise<AdminRefundDetail> {
  return apiGet<AdminRefundDetail>(`/api/admin/refunds/${encodeURIComponent(id)}`);
}

/**
 * 三个审核动作。都是 POST，请求体只有幂等键（通过与被拒绝另加审核意见）。
 *
 * ⚠️ **请求体里没有金额**（P0-13 起口径微调：通过动作传的是**比例**，仍然不是金额）。
 * 管理员填写退款比例与责任归属，三个金额由服务端按订单冻结的经济快照算出来
 * （`业务流程表.md` §16.B：「管理员只输入退款比例，金额由系统计算」）。
 * 类型上也没有任何字段能传金额进来。
 *
 * ⚠️ 三个动作是**三个接口**，不是一个「把状态改成 X」的接口：通过会在同一次写入里
 * 写入资金决策、订单累计退款额与打手收益冲回（累计退满时才改订单状态），
 * 与「开始审核」这种只改一个状态的动作用途完全不同，
 * 合成一个接口就会出现「点错按钮直接把款退了」这种后果很重的错误。
 *
 * ⚠️ 通过是 **Mock 审核**：不调用真实微信退款、不生成微信退款单号、不代表款项已退回。
 */
export function startReviewRefund(
  id: string,
  idempotencyKey: string,
): Promise<AdminRefundWriteResult> {
  return apiPost<AdminRefundWriteResult>(
    `/api/admin/refunds/${encodeURIComponent(id)}/start-review`,
    { idempotencyKey },
  );
}

/**
 * 资金决策三件套（P0-13）—— 通过动作的必填入参。
 *
 * ⚠️ **比例用字符串、不用数字**：`"0"` 与「没填」在数字口径下都是 `0` 或 `undefined`，
 * 而它们是完全不同的两件事（填了 0% 是「不退钱」，没填是「还没决定」）。
 * 服务端按整数字符串解析，`"33.5"` 一律 400（金额字段不做静默取整）。
 *
 * ⚠️ **责任比例只在分担制下存在于类型上**（判别联合，不是可选字段）：
 * `platform` / `companion` 传了责任比例会被服务端 400 拒绝，而不是被静默忽略
 * ——金额字段「填了但没生效」比报错危险得多。类型上就写不出来，比运行时再拦一道更早。
 */
export type AdminRefundDecisionRequest =
  | {
      /** 0~100 的整数字符串（0% 会被服务端按「退款金额为 0」拒绝） */
      refundRatePercent: string;
      responsibility: "shared";
      /** 0~100 的整数字符串 */
      companionLiabilityRatePercent: string;
    }
  | {
      refundRatePercent: string;
      responsibility: "platform" | "companion";
      companionLiabilityRatePercent?: never;
    };

/**
 * 审核通过：资金决策、退款记录、订单与打手收益在同一次写入里改到位。`reviewNote` 选填。
 *
 * ⚠️ **页面不做金额预览**（`architecture-rules.md` §三：客户端不做金额算术）：
 * 按钮只说「按 X% 退款，金额由系统计算」，实际金额读响应里的 `decidedAmount`。
 */
export function approveRefund(
  id: string,
  idempotencyKey: string,
  reviewNote: string,
  decision: AdminRefundDecisionRequest,
): Promise<AdminRefundWriteResult> {
  return apiPost<AdminRefundWriteResult>(`/api/admin/refunds/${encodeURIComponent(id)}/approve`, {
    idempotencyKey,
    reviewNote,
    refundRatePercent: decision.refundRatePercent,
    responsibility: decision.responsibility,
    // 只有分担制才带上责任比例：其余两种传了会 400（服务端刻意不静默忽略）
    ...(decision.responsibility === "shared"
      ? { companionLiabilityRatePercent: decision.companionLiabilityRatePercent }
      : {}),
  });
}

/** 审核拒绝：**必须填写审核意见**（服务端校验），订单状态与消费金额都不变。 */
export function rejectRefund(
  id: string,
  idempotencyKey: string,
  reviewNote: string,
): Promise<AdminRefundWriteResult> {
  return apiPost<AdminRefundWriteResult>(`/api/admin/refunds/${encodeURIComponent(id)}/reject`, {
    idempotencyKey,
    reviewNote,
  });
}

// ——————————————————————————— 投诉处理（P8C） ———————————————————————————

export type AdminComplaintListRequest = {
  status?: AdminComplaintStatusFilter;
  type?: AdminComplaintTypeFilter;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

/** 取一页投诉。列表**不含正文、凭证、联系方式与处理结果**。 */
export function fetchAdminComplaints(
  input: AdminComplaintListRequest = {},
): Promise<AdminComplaintListData> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.type) params.set("type", input.type);
  if (input.keyword) params.set("keyword", input.keyword);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_COMPLAINT_PAGE_SIZE));

  return apiGet<AdminComplaintListData>(`/api/admin/complaints?${params.toString()}`);
}

/** 取一条投诉详情（含正文、凭证、联系方式、处理信息与服务端判定的可执行动作）。 */
export function fetchAdminComplaint(id: string): Promise<AdminComplaintDetail> {
  return apiGet<AdminComplaintDetail>(`/api/admin/complaints/${encodeURIComponent(id)}`);
}

/**
 * 三个处理动作。都是 POST，请求体只有幂等键（解决与关闭另加处理结果 / 关闭说明）。
 *
 * ⚠️ **请求体里没有任何订单或金额字段**：投诉处理不修改订单，也不产生退款（§投诉处理）。
 * 用户提交的正文、凭证与联系方式同样没有可传的位置——它们不可被覆盖。
 *
 * ⚠️ 「开始处理」不传 `result`：它不产生结论，服务端也不会读这个字段。
 */
export function startProcessingComplaint(
  id: string,
  idempotencyKey: string,
): Promise<AdminComplaintWriteResult> {
  return apiPost<AdminComplaintWriteResult>(
    `/api/admin/complaints/${encodeURIComponent(id)}/start-processing`,
    { idempotencyKey },
  );
}

/** 解决投诉：**必须填写处理结果**。处理结果会同步展示给提交投诉的用户。 */
export function resolveComplaint(
  id: string,
  idempotencyKey: string,
  result: string,
): Promise<AdminComplaintWriteResult> {
  return apiPost<AdminComplaintWriteResult>(
    `/api/admin/complaints/${encodeURIComponent(id)}/resolve`,
    { idempotencyKey, result },
  );
}

/** 关闭投诉：**必须填写关闭说明**。`closed` 是终态，之后不能再改为已处理。 */
export function closeComplaint(
  id: string,
  idempotencyKey: string,
  result: string,
): Promise<AdminComplaintWriteResult> {
  return apiPost<AdminComplaintWriteResult>(
    `/api/admin/complaints/${encodeURIComponent(id)}/close`,
    { idempotencyKey, result },
  );
}

// ——————————————————————————— 客服账号 ———————————————————————————

export type AdminStaffListRequest = {
  state?: AdminStaffStateFilter;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 管理端客服账号列表。
 *
 * ⚠️ 返回项里**没有** Cookie、密码、会话标识或仓储内部索引——
 * 前三样在这份数据里根本不存在（本阶段是 Mock 认证，账号没有密码字段）。
 */
export function fetchAdminStaffList(
  input: AdminStaffListRequest = {},
): Promise<AdminStaffListData> {
  const params = new URLSearchParams();
  if (input.state) params.set("state", input.state);
  if (input.keyword) params.set("keyword", input.keyword);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_STAFF_PAGE_SIZE));

  return apiGet<AdminStaffListData>(`/api/admin/staff?${params.toString()}`);
}

/** 取一个客服账号的详情。比列表多 `role` 与 `canEnterStaffConsole` 两个服务端结论。 */
export function fetchAdminStaff(id: string): Promise<AdminStaffDetail> {
  return apiGet<AdminStaffDetail>(`/api/admin/staff/${encodeURIComponent(id)}`);
}

/**
 * 新增客服账号。
 *
 * ⚠️ 请求体只有**三个资料字段**与幂等键：没有 `role`、没有 `enabled`、
 * 没有密码。角色由服务端写死为客服（`customer_service`），新账号一律是启用、未移除的。
 * 因此「提交 `role: "admin"` 就建出一个管理员」在请求体里没有落脚的地方。
 */
export function createAdminStaff(
  idempotencyKey: string,
  input: AdminStaffProfileInput,
): Promise<AdminStaffWriteResult> {
  return apiPost<AdminStaffWriteResult>("/api/admin/staff", {
    idempotencyKey,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
  });
}

/**
 * 编辑客服账号资料（登录名 / 名称 / 头像）。
 *
 * ⚠️ 同样**不碰状态**：启用、停用、移除各有自己的接口。
 * 编辑时顺手写状态，会在两位管理员同时操作时让后写的那次把刚停用的账号重新启用。
 */
export function saveAdminStaffProfile(
  id: string,
  idempotencyKey: string,
  input: AdminStaffProfileInput,
): Promise<AdminStaffWriteResult> {
  return apiPatch<AdminStaffWriteResult>(`/api/admin/staff/${encodeURIComponent(id)}`, {
    idempotencyKey,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
  });
}

/** 启用客服账号。不重置任何资料；**已移除的账号不能被启用**。 */
export function enableAdminStaff(
  id: string,
  idempotencyKey: string,
): Promise<AdminStaffWriteResult> {
  return apiPost<AdminStaffWriteResult>(`/api/admin/staff/${encodeURIComponent(id)}/enable`, {
    idempotencyKey,
  });
}

/**
 * 停用客服账号。
 *
 * ⚠️ 停用后该账号**立即失去客服工作台权限**，现有客服端 Cookie 也失效——
 * 靠的是客服端每个请求都重新查一次账号状态，不是靠这里删会话（本阶段没有会话表）。
 */
export function disableAdminStaff(
  id: string,
  idempotencyKey: string,
): Promise<AdminStaffWriteResult> {
  return apiPost<AdminStaffWriteResult>(`/api/admin/staff/${encodeURIComponent(id)}/disable`, {
    idempotencyKey,
  });
}

/**
 * 移除客服账号（**软删除**）。
 *
 * ⚠️ 只写 `removedAt` 并同时停用：记录与历史消息都保留。
 * 移除后不能登录、不能进工作台、也不能再启用，没有「撤销移除」这个动作。
 */
export function removeAdminStaff(
  id: string,
  idempotencyKey: string,
): Promise<AdminStaffWriteResult> {
  return apiPost<AdminStaffWriteResult>(`/api/admin/staff/${encodeURIComponent(id)}/remove`, {
    idempotencyKey,
  });
}

// ——————————————————————————— 运营内容（P8E-1） ———————————————————————————

/**
 * 三张内容列表共用的查询参数。
 *
 * ⚠️ **没有分页参数**，而且不是「这一版先不做」：这类运营内容在任何现实运营里
 * 都是个位数到几十条（见 `AdminContentList` 的注释），加分页会带来
 * 「改完第 3 页的排序、第 1 页没变」这类纯粹由分页制造的问题。
 * 接口同样读不到 `page` / `pageSize`，传了也不会有任何效果。
 */
export type AdminContentListRequest = {
  /** `active`（默认）看未移除的；`removed` 只看被软移除的 */
  removal?: ContentRemovalFilter;
};

/**
 * 拼一张内容列表的地址。
 *
 * ⚠️ 默认值也**显式写进地址栏**（`removal=active`）：这一页的筛选状态在 URL 里
 * 看得见，复制给同事的链接打开的是同一个视图，而不是「我以为是默认值」的另一份数据。
 */
function contentListPath(segment: string, input: AdminContentListRequest): string {
  const params = new URLSearchParams();
  params.set("removal", input.removal ?? "active");
  return `/api/admin/content/${segment}?${params.toString()}`;
}

/**
 * 三组内容的写操作形状完全相同，只有路径段不同。
 *
 * ⚠️ 走的是**窄写入**接口而不是「把整条记录写回去」：列表上的「停用」只应当改
 * `enabled` 一个字段，不该顺带把标题、图片、排序覆盖成按钮渲染时的旧值——
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的标题改回旧值（§九）。
 * 「移除」同理：它是一条独立的状态迁移，不是一次普通保存。
 */
function contentWritePath(segment: string, id: string, action?: string): string {
  const base = `/api/admin/content/${segment}/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

/**
 * 三组内容写操作的返回（界面真正读得懂的那两个字段）。
 *
 * ⚠️ 服务端返回的是一个**信封**而不是记录本身，理由在
 * `lib/services/adminAnnouncements.ts` 的 `AdminAnnouncementWriteResult`：
 * 一次写请求有三种「没写」的可能，客户端必须能分清——
 *
 * - `changed: false`：提交的内容与现状一模一样（点了一次保存却没改任何东西）。
 *   界面**不能**显示成「已保存」，那会让人以为自己刚才的改动生效了（§九）。
 * - `replayed: true`：这个幂等键早就做过了，服务端没有第二次写入。
 *   这是重试命中了第一次的结果，与「本次写成功」不是同一件事。
 *
 * 这里只声明这两个字段：接口还返回 `action`（事务层算好的审计动作名）与确认后的记录
 * （公告/活动图放在 `updated` 里，快捷入口直接展开在顶层），但**界面不用它们**——
 * 写成功之后页面显示的那一行由「重新取一份列表」决定，读响应的几个字段自己拼一行出来
 * 会和真实记录分叉。声明成响应体的**子集**，因此服务端多返回一个字段也不会让它报错。
 */
export type AdminContentWriteAck = {
  changed: boolean;
  replayed: boolean;
};

// —— 图片公告 ——

/** 取一页图片公告（**不分页**，含停用的；`removal=removed` 时是已移除的那批）。 */
export function fetchAdminAnnouncements(
  input: AdminContentListRequest = {},
): Promise<AdminContentList<AdminAnnouncementItem>> {
  return apiGet<AdminContentList<AdminAnnouncementItem>>(contentListPath("announcements", input));
}

/** 新建一条公告。启用状态由服务端按 `enabled` 写入，客户端无法自己成为「已启用」以外的东西。 */
export function createAdminAnnouncement(
  idempotencyKey: string,
  patch: AdminAnnouncementProfilePatch,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>("/api/admin/content/announcements", {
    idempotencyKey,
    ...patch,
  });
}

/** 编辑公告（整份资料的覆盖写：名称 / 图片地址 / 图片说明 / 排序 / 启用状态）。 */
export function saveAnnouncementProfile(
  id: string,
  idempotencyKey: string,
  patch: AdminAnnouncementProfilePatch,
): Promise<AdminContentWriteAck> {
  return apiPatch<AdminContentWriteAck>(contentWritePath("announcements", id), {
    idempotencyKey,
    ...patch,
  });
}

export function enableAnnouncement(
  id: string,
  idempotencyKey: string,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("announcements", id, "enable"), {
    idempotencyKey,
  });
}

export function disableAnnouncement(
  id: string,
  idempotencyKey: string,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("announcements", id, "disable"), {
    idempotencyKey,
  });
}

/** 移除公告（软删除）。**记录不删**：用户当时看到的是哪张图，事后要能回答。 */
export function removeAnnouncement(
  id: string,
  idempotencyKey: string,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("announcements", id, "remove"), {
    idempotencyKey,
  });
}

// —— 活动 Banner ——

/**
 * 取一页活动 Banner（**不分页**）。
 *
 * ⚠️ 后台可以预置多张 Banner，但用户端首页**只展示排序最前的那一张启用图**
 * （`selectActivityImageUrl()`）。因此这里的 `sortOrder` 与 `enabled` 不是
 * 「一堆图里的偏好」，而是「现在前台看到的是哪一张」这个唯一答案的输入。
 */
export function fetchAdminBanners(
  input: AdminContentListRequest = {},
): Promise<AdminContentList<AdminBannerItem>> {
  return apiGet<AdminContentList<AdminBannerItem>>(contentListPath("banners", input));
}

export function createAdminBanner(
  idempotencyKey: string,
  patch: AdminBannerProfilePatch,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>("/api/admin/content/banners", { idempotencyKey, ...patch });
}

export function saveBannerProfile(
  id: string,
  idempotencyKey: string,
  patch: AdminBannerProfilePatch,
): Promise<AdminContentWriteAck> {
  return apiPatch<AdminContentWriteAck>(contentWritePath("banners", id), {
    idempotencyKey,
    ...patch,
  });
}

export function enableBanner(id: string, idempotencyKey: string): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("banners", id, "enable"), {
    idempotencyKey,
  });
}

export function disableBanner(id: string, idempotencyKey: string): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("banners", id, "disable"), {
    idempotencyKey,
  });
}

export function removeBanner(id: string, idempotencyKey: string): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("banners", id, "remove"), {
    idempotencyKey,
  });
}

// —— 快捷入口 ——

/**
 * 取一页快捷入口（**不分页**）。
 *
 * ⚠️ 用户端是**四宫格**：多于四条时后面的会被挤到下一行、布局不再是设计稿里的样子。
 * 后台因此不限制数量，但页面必须把这件事说出来（`sortOrder` 决定谁在前四个位置）。
 */
export function fetchAdminQuickEntries(
  input: AdminContentListRequest = {},
): Promise<AdminContentList<AdminQuickEntryItem>> {
  return apiGet<AdminContentList<AdminQuickEntryItem>>(contentListPath("quick-entries", input));
}

export function createAdminQuickEntry(
  idempotencyKey: string,
  patch: AdminQuickEntryProfilePatch,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>("/api/admin/content/quick-entries", {
    idempotencyKey,
    ...patch,
  });
}

export function saveQuickEntryProfile(
  id: string,
  idempotencyKey: string,
  patch: AdminQuickEntryProfilePatch,
): Promise<AdminContentWriteAck> {
  return apiPatch<AdminContentWriteAck>(contentWritePath("quick-entries", id), {
    idempotencyKey,
    ...patch,
  });
}

export function enableQuickEntry(
  id: string,
  idempotencyKey: string,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("quick-entries", id, "enable"), {
    idempotencyKey,
  });
}

export function disableQuickEntry(
  id: string,
  idempotencyKey: string,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("quick-entries", id, "disable"), {
    idempotencyKey,
  });
}

export function removeQuickEntry(
  id: string,
  idempotencyKey: string,
): Promise<AdminContentWriteAck> {
  return apiPost<AdminContentWriteAck>(contentWritePath("quick-entries", id, "remove"), {
    idempotencyKey,
  });
}

// —— 协议与版本介绍 ——

/**
 * 取协议列表。
 *
 * ⚠️ **没有新建、没有移除，也没有分页**：协议是五类固定的内容
 * （`AGREEMENT_TYPES`），同一个类型可以有多个版本，但「哪一版是当前版本」
 * 由版本号与启用状态决定，不是靠删掉旧版本做到的。
 */
export function fetchAdminAgreements(): Promise<AdminAgreementListData> {
  return apiGet<AdminAgreementListData>("/api/admin/content/agreements");
}

/**
 * 取一份协议的**正文**（列表行 + `sections`）。
 *
 * ⚠️ 编辑表单必须走它：列表行刻意不带正文（`AdminAgreementListItem` 里没有 `sections`），
 * 拿列表去拼编辑表单只能拼出一个空正文，一保存就把用户看到的协议清空了。
 */
export function fetchAdminAgreementDetail(id: string): Promise<AdminAgreementDetail> {
  return apiGet<AdminAgreementDetail>(`/api/admin/content/agreements/${encodeURIComponent(id)}`);
}

/**
 * 编辑一份协议（标题 / 正文段落 / 启用状态）。
 *
 * ⚠️ 正文是**结构化段落**，不是 HTML 字符串：`sections` 里每个元素是
 * `{ heading, paragraphs }`，页面按段落渲染。因此这里传不出
 * `<script>` 这类东西——客户端根本没有一个「把 HTML 发上去」的字段。
 *
 * ⚠️ 版本号不在请求体里：正文变化时由服务端**自动递增**
 * （`bumpAgreementVersion()`），客户端伪造一个版本号没有可传的位置。
 *
 * ⚠️ 返回的是**写入结果**（`AdminAgreementWriteResult`）而不是详情：它不带正文，
 * 但带一个 `changed`。界面靠它区分「真的写进去了」与「提交的内容与现状完全一致」
 * ——后者**不是错误**，却绝不能显示成「保存成功」（§九）。写入后的新正文
 * 由服务端在写入时算出来，要看得重新取一次详情，不能拿本地那份拼。
 */
export function saveAgreementProfile(
  id: string,
  idempotencyKey: string,
  patch: AdminAgreementProfilePatch,
): Promise<AdminAgreementWriteResult> {
  return apiPatch<AdminAgreementWriteResult>(
    `/api/admin/content/agreements/${encodeURIComponent(id)}`,
    { idempotencyKey, ...patch },
  );
}

/** 启用一份协议。重复启用是幂等的：服务端返回 `changed: false`，不产生第二次写入。 */
export function enableAgreement(
  id: string,
  idempotencyKey: string,
): Promise<AdminAgreementWriteResult> {
  return apiPost<AdminAgreementWriteResult>(
    `/api/admin/content/agreements/${encodeURIComponent(id)}/enable`,
    { idempotencyKey },
  );
}

/** 停用一份协议。停用后用户端看到的是同类型里版本号最高的那份**启用**内容。 */
export function disableAgreement(
  id: string,
  idempotencyKey: string,
): Promise<AdminAgreementWriteResult> {
  return apiPost<AdminAgreementWriteResult>(
    `/api/admin/content/agreements/${encodeURIComponent(id)}/disable`,
    { idempotencyKey },
  );
}

// ——————————————————————————— 平台参数 ———————————————————————————

/**
 * 取当前平台参数。
 *
 * ⚠️ 地址里**没有 id**：平台参数是单例，全局只有这一份配置。用
 * `/api/admin/platform-config` 而不是 `/api/admin/platform-configs/1`，
 * 是为了让「参数只有一份」这件事在地址上就成立。
 */
export function fetchAdminPlatformConfig(): Promise<PlatformConfig> {
  return apiGet<PlatformConfig>("/api/admin/platform-config");
}

/**
 * 修改平台参数。
 *
 * 只提交要改的字段（PATCH）：`updatedAt` / `updatedByAdminId` 不在
 * `AdminPlatformConfigPatch` 里，它们由服务端按会话与时钟填。
 *
 * ⚠️ 返回的是**写入结果**而不是「成功」：它带回整份配置与服务端的 `changed`。
 * 界面用 `changed === false` 区分「服务端没有产生新的改动」（提交的值与现状相同，
 * 或同一个幂等键第二次到达）。那种情况**不是错误**，但绝不能显示成「已保存」——
 * 管理员会以为值变了，而实际上 `updatedAt` 与配置都没动。
 */
export function saveAdminPlatformConfig(
  idempotencyKey: string,
  patch: AdminPlatformConfigPatch,
): Promise<AdminPlatformConfigWriteResult> {
  return apiPatch<AdminPlatformConfigWriteResult>("/api/admin/platform-config", {
    idempotencyKey,
    ...patch,
  });
}
