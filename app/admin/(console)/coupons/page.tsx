import AdminCouponGrantConsole from "@/components/admin/AdminCouponGrantConsole";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COUPONS_NOTICE, ADMIN_COUPONS_PAGE_TITLE } from "@/lib/constants/admin";
import { listCouponGrantOptions } from "@/lib/services/adminCoupons";
import type { AdminCouponGrantOption } from "@/lib/types/coupon";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 优惠券发放（`/admin/coupons`）。
 *
 * 阅读顺序与其余管理页一致：**首屏由服务端取数 → 客户端接管**。
 * 券模板由这一层取好交给 `AdminCouponGrantConsole`，因此直接打开这一页看到的是
 * 可选模板，而不是一片骨架屏；之后搜索用户与发放都由浏览器发起。
 *
 * ⚠️ 取数走的是**服务层**（`listCouponGrantOptions`），不是本项目自己的接口：
 * Server Component 通过 HTTP 打自己的 Route Handler 会带来构建期自请求、
 * 对部署地址的依赖与多一次网络跳转。两侧调用的是**同一个函数**，
 * 因此「页面看到的券面」与「接口返回的券面」不会分叉。
 *
 * ⚠️ **只取券模板这一半**：目标用户必须由管理员输入关键词**主动搜**，
 * 没有「首屏先把全量用户列出来」这种东西（服务端对空关键词返回空列表）。
 *
 * ⚠️ 查询串**不参与任何业务判定**——这一页没有「按地址栏筛选」这件事，
 * 发券的对象与模板都在这页里选，地址栏上本来就没有可携带的状态。
 * 它只做一件事：把 `?mockError=` / `?mockDelay=` 这类 **Mock 调试参数**原样透传给
 * 服务层（与其他管理页同一做法，见 `lib/mocks/debug.ts` 的 `MockSurface`）。
 * 这点透传是**必需的**：没有它，`?mockError=1` 就打不到首屏取数，
 * 「取数失败时页面不崩、显示错误与重试」这条行为将无法被验收。
 * 真实后端不读这些参数，接入后这一层随 Mock 一起删掉。
 *
 * ⚠️ **首屏取数失败不整页崩掉**：捕获后把空列表与错误消息一起交给客户端组件，
 * 由它显示错误与「重试」（重试走浏览器请求）。失败在这里被吞掉是**故意的**——
 * 一个模板列表拉不到，不该让管理员连侧栏与导航都一起失去。
 * 错误消息**原样传递**，页面不重编一句，保证与接口说的原因是同一句。
 */
export default async function AdminCouponsPage({
  searchParams,
}: PageProps<"/admin/coupons">) {
  const params = toSearchParams(await searchParams);

  let options: AdminCouponGrantOption[] = [];
  let error = "";

  try {
    options = await listCouponGrantOptions(params, "server");
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "券模板加载失败，请稍后重试。";
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={ADMIN_COUPONS_PAGE_TITLE} description={ADMIN_COUPONS_NOTICE} />

      <AdminCouponGrantConsole initialOptions={options} initialError={error} />
    </div>
  );
}
