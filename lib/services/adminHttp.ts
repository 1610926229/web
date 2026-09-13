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
