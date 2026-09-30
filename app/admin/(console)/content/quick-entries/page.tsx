import AdminQuickEntryConsole from "@/components/admin/AdminQuickEntryConsole";
import { resolveContentRemovalFilter } from "@/lib/constants/adminContent";
import { queryAdminQuickEntryList } from "@/lib/services/adminQuickEntries";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 快捷入口（`/admin/content/quick-entries`）。
 *
 * ⚠️ 这一页与公告 / 活动图有一个**形状上的**差别：列表服务的第一个参数就是
 * `ContentRemovalFilter`（不是 `{ removal }` 的查询对象），因为入口列表只有
 * 「要不要看已移除的那批」这一个维度。这里不为了「三页写法一致」而把过滤器
 * 包成对象——那会多一层没有任何含义的包装。
 *
 * 地址栏参数沿用同一套宽松解析（`resolveContentRemovalFilter()`，非法值收敛到
 * `active`）：与约定俗成的「筛选状态看得见」一致，只是没有严格模式那一档——
 * 解析函数是常量层的纯函数，接口那一路的严格校验由服务层自己补。
 */
export default async function AdminContentQuickEntriesPage({
  searchParams,
}: PageProps<"/admin/content/quick-entries">) {
  const params = toSearchParams(await searchParams);
  const removal = resolveContentRemovalFilter(params.get("removal"));
  const data = await queryAdminQuickEntryList(removal, params, "server");

  return <AdminQuickEntryConsole initialResult={data} initialRemoval={removal} />;
}
