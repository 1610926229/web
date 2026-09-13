import { notFound } from "next/navigation";
import NavBar from "@/components/common/NavBar";
import CompanionDetailView from "@/components/companions/CompanionDetailView";
import { COMPANION_DETAIL_PAGE_TITLE } from "@/lib/constants/companions";
import { getCompanionDetail } from "@/lib/services/companions";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 陪玩详情。**游客可访问**，二级页面（顶部返回、无底部 TabBar）。
 *
 * 三种数据状态分得很清楚：
 *
 * - **不存在**（id 取不到数据）→ `notFound()`，与商品详情同一套 404 处理；
 * - **不在公开名单里**（`listed: false`）：服务端**仍然返回详情**，页面渲染成一页只读资料，
 *   **没有选择或下单入口**。直接给 404 是不对的——这位陪玩确实存在过，链接也没错，
 *   只是现在不在名单里；
 * - **在架但暂不可用**（休息中 / 已排满）：正常展示，标出**具体原因**，按钮禁用。
 *
 * ⚠️ **本路由上下都不能有 `loading.tsx`**（与 `app/product/[id]` 一样）：`loading.tsx` 会让
 * 外壳先以 200 发出，随后到达的 `notFound()` 只能改页面内容、改不了已经发出的状态码，
 * 于是「不存在的陪玩」会变成一屏 200 的 404 文案。这里选择了状态码正确的那一边。
 * 这也是兄弟目录 `(list)` 存在的原因：列表的加载边界（它需要，否则取数失败会 500）
 * 必须收在列表自己那一段里，不能上提到 `app/companions/` 把本路由一起罩住。
 * 代价是取数失败发生在外壳阶段，`error.tsx` 接不住（与商品详情完全相同）——
 * 因此 `error.tsx` 只是兜底，错误态与重试由列表、`/join`、`/join/status` 三处负责演示。
 *
 * 全页由服务端渲染，取到的只有 `CompanionDetail` 这个公开 DTO：
 * 登录用户 ID、联系方式、入驻申请内容、内部审核备注、仓储的 `sortOrder` / `enabled`
 * 都不在 DTO 里，因此不存在「不小心渲染出来」的可能。
 *
 * 详情页**没有任何下单能力**：选择陪玩的交互只存在于客户端组件的本地 state，
 * 不发请求、不写存储、不改动结算页。陪玩与订单的绑定规则尚未确认。
 */
export default async function CompanionDetailPage({
  params,
  searchParams,
}: PageProps<"/companions/[id]">) {
  const { id } = await params;
  // 查询参数原样交给 service（Mock 调试参数由此生效），页面不判断开关
  const query = toSearchParams(await searchParams);

  const companion = await getCompanionDetail(id, query, "server");
  if (!companion) notFound();

  return (
    <>
      <NavBar title={COMPANION_DETAIL_PAGE_TITLE} showBack />
      <CompanionDetailView companion={companion} />
    </>
  );
}
