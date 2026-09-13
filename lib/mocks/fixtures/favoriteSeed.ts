import type { Favorite } from "@/lib/types/favorite";

/**
 * 商品收藏的预置数据。
 *
 * ⚠️ 全部为 Mock 数据，仅用于打通取数链路与版式验证；接入真实后端后随本目录一并移除。
 *
 * 刻意构造出的四种情况（收藏列表必须都能安全展示）：
 *
 * 1. **在售商品**：正常卡片，可进详情、可下单；
 * 2. **已下架商品**（`p-off-1`）：历史上收藏过，现在仍能看见并显示「已下架」，但**不能购买**；
 * 3. **已不存在的商品**（`p-removed-1`）：商品已从数据源删除，收藏记录还在——
 *    列表必须跳过它继续渲染，不能让一条脏数据把整页打白；
 * 4. **另一个用户的收藏**（`u-1002`）：验证 A 看不到 B 的收藏。
 *
 * 记录里只有商品 id，**没有商品快照**：商品改名改价后，列表展示的是当前信息。
 * createdAt 全部写死而不是取当前时间，收藏顺序在每次运行时都完全一致。
 *
 * u-1001 有 14 条，超过一页（默认 10 条），因此「加载更多」与分页去重能被真实验收。
 */

/** 已经不在商品表里的商品 id：用来验证收藏列表对「商品已删除」的安全处理 */
export const REMOVED_PRODUCT_ID = "p-removed-1";

export const favoriteSeed: Favorite[] = [
  // —— u-1001：12 件在售商品 ——
  { id: "fav-1001-01", userId: "u-1001", productId: "p-400w", createdAt: "2026-09-12T21:18:00.000Z" },
  { id: "fav-1001-02", userId: "u-1001", productId: "p-200w", createdAt: "2026-09-12T20:42:00.000Z" },
  { id: "fav-1001-03", userId: "u-1001", productId: "p-jm200w", createdAt: "2026-09-12T19:05:00.000Z" },
  { id: "fav-1001-04", userId: "u-1001", productId: "p-sh300w", createdAt: "2026-09-11T22:31:00.000Z" },
  { id: "fav-1001-05", userId: "u-1001", productId: "p-150w", createdAt: "2026-09-11T18:47:00.000Z" },
  { id: "fav-1001-06", userId: "u-1001", productId: "p-300w", createdAt: "2026-09-10T21:12:00.000Z" },
  { id: "fav-1001-07", userId: "u-1001", productId: "p-600w", createdAt: "2026-09-10T12:26:00.000Z" },
  { id: "fav-1001-08", userId: "u-1001", productId: "p-500w", createdAt: "2026-09-09T20:58:00.000Z" },
  { id: "fav-1001-09", userId: "u-1001", productId: "p-800w", createdAt: "2026-09-09T15:33:00.000Z" },
  { id: "fav-1001-10", userId: "u-1001", productId: "p-1000w", createdAt: "2026-09-08T21:40:00.000Z" },
  { id: "fav-1001-11", userId: "u-1001", productId: "p-fun-1", createdAt: "2026-09-08T11:09:00.000Z" },
  { id: "fav-1001-12", userId: "u-1001", productId: "p-speed-1", createdAt: "2026-09-07T19:24:00.000Z" },

  // —— u-1001：已下架，历史上收藏过 ——
  { id: "fav-1001-13", userId: "u-1001", productId: "p-off-1", createdAt: "2026-09-07T10:15:00.000Z" },

  // —— u-1001：商品已从数据源删除，收藏记录仍在 ——
  { id: "fav-1001-14", userId: "u-1001", productId: REMOVED_PRODUCT_ID, createdAt: "2026-09-06T16:02:00.000Z" },

  // —— u-1002：另一个用户的收藏，用于验证隔离 ——
  { id: "fav-1002-01", userId: "u-1002", productId: "p-vr-1", createdAt: "2026-09-12T09:30:00.000Z" },
  { id: "fav-1002-02", userId: "u-1002", productId: "p-vt-1", createdAt: "2026-09-11T14:06:00.000Z" },
];
