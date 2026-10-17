import AdminAgreementConsole from "@/components/admin/AdminAgreementConsole";
import { queryAdminAgreementList, resolveAdminAgreementListQuery } from "@/lib/services/adminAgreements";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 协议与版本介绍（`/admin/content/agreements`）。
 *
 * 列表一次全部返回（五类、含停用的那份）：分页会引入「第 2 页上有一条被停用的协议
 * 没被看见」这类运营事故，而它换来的收益在只有五项数据时等于零。
 *
 * ⚠️ 列表行里**没有正文**（`sectionCount` / `paragraphCount` 两个标量代替）：
 * 正文由编辑表单按 id 单独取一份详情。理由见 `AdminAgreementConsole` 的注释——
 * 拿列表去拼表单只能拼出一个空正文，一保存就把用户看到的协议清空了。
 *
 * `resolveAdminAgreementListQuery()` 目前**有意不使用**地址栏参数（没有筛选、
 * 没有分页、没有关键字），保留它是为了让调用形状与其它管理列表一致，将来加筛选时
 * 从那里进——所以这一页仍然照常把 `params` 传下去。
 */
export default async function AdminContentAgreementsPage({
  searchParams,
}: PageProps<"/admin/content/agreements">) {
  const params = toSearchParams(await searchParams);
  const query = resolveAdminAgreementListQuery(params);
  const data = await queryAdminAgreementList(query, params, "server");

  return <AdminAgreementConsole initialData={data} />;
}
