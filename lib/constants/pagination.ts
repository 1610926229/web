/**
 * 分页参数的规范化规则（订单列表、投诉列表共用）。
 *
 * 也包括「加载更多」的合并规则：它是分页的另一半，写错了一样会让列表显示不全。
 *
 * ⚠️ 本文件没有任何运行时依赖，客户端与服务端都能引用，node 也能直接加载它做测试。
 *
 * 分页参数**规范化**而不是报错：页码不是用户填写的业务内容，一个坏掉的页码让整页报错
 * 没有意义。与之相对，状态取值是明确的业务条件，写错必须报错——
 * 各列表的 `parse*Query` 里体现的就是这个区别。
 */

import type { PageResult } from "@/lib/types/common";

/** 页码上限：超过就按上限处理，避免构造出天文数字的偏移量。 */
export const MAX_PAGE = 1000;

/** 页码：缺失 / 非数字 / 小于 1 一律回到第 1 页，超过上限按上限处理。 */
export function clampPage(raw: string | null, maxPage: number = MAX_PAGE): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.trunc(value), maxPage);
}

/** 每页条数：缺失 / 非数字 / 小于 1 用各自的默认值，超过上限按上限处理。 */
export function clampPageSize(raw: string | null, fallback: number, maxPageSize: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.trunc(value), maxPageSize);
}

/**
 * 把「加载更多」取回的一页**并到已有列表后面**，并按 id 去重。
 *
 * 两件事都必须在这里做，页面才不会出问题：
 *
 * 1. **追加是合并，不是替换**。只把新一页赋值回去，前面几页会凭空消失——
 *    看起来像「加载更多把列表变短了」。
 * 2. **去重要兜住翻页期间的插入**。翻到第二页之前如果有一条新记录进到最前面，
 *    后面几页会整体后移，同一条可能在两页里各出现一次。这是偏移量分页固有的限制，
 *    接口按页返回数据，界面这一层负责不把重复的卡片画出来。
 *
 * 规则只写这一处：组件不自己拼数组，也就不会出现「某个列表忘了去重」。
 * 新一页的 `page` / `hasMore` / `total` 一律采用 `next` 的（它才代表最新一次请求的结果）。
 */
export function mergePageResult<T extends { id: string }, P extends PageResult<T>>(
  current: P,
  next: P,
): P {
  // 显式写出回调参数类型：`T` 只出现在 `P` 的约束里，推断不出，否则会被当成 unknown
  return mergePageResultBy(current, next, (item: T) => item.id);
}

/**
 * 同上，但由调用方给出「哪一项算同一条」。
 *
 * 待评价订单列表里的身份字段是 `orderId` 而不是 `id`（它不是一条评价记录，
 * 只是一笔还没评价的订单），因此不能套用按 `id` 去重的版本。
 */
export function mergePageResultBy<T, P extends PageResult<T>>(
  current: P,
  next: P,
  keyOf: (item: T) => string,
): P {
  const seen = new Set(current.items.map(keyOf));
  return {
    ...next,
    items: [...current.items, ...next.items.filter((item) => !seen.has(keyOf(item)))],
  } as P;
}
