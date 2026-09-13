import NavBar from "@/components/common/NavBar";
import CouponList, { type CouponInitial } from "@/components/coupons/CouponList";
import RequireAuth from "@/lib/auth/RequireAuth";
import { parseCouponTab } from "@/lib/constants/coupons";
import { queryCouponsForUser } from "@/lib/services/coupons";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 我的优惠券（需登录）。
 *
 * 二级页面：在 `(tabs)` 之外，用顶部返回、**不带底部 TabBar**。
 * NavBar 放在 `RequireAuth` 外面，未登录时也能返回上一页，登录后地址仍是 `/coupons`。
 *
 * 首屏只取**当前 Tab** 那一页（地址里的 `?tab=` 决定），另一个 Tab 由客户端按需取：
 * 首屏取两份会让「加载中 / 空 / 出错重试」这几个状态永远看不到。
 * 切 Tab 与加载更多由 `CouponList` 以浏览器请求完成，两条链路共用
 * `lib/services/coupons.ts` 的同一个函数，取数口径只有一套。
 *
 * 地址里的 Tab 取值非法时**在页面这一层忽略掉、按「已拥有」展示**：页面地址是用户
 * 随手可改的，不该因此把整页变成错误页；接口收到非法取值则返回 400。
 */
export default async function CouponsPage({ searchParams }: PageProps<"/coupons">) {
  const query = toSearchParams(await searchParams);
  const parsed = parseCouponTab(query.get("tab"));
  const initialTab = parsed === "invalid" ? "owned" : parsed;

  return (
    <>
      <NavBar title="我的优惠券" showBack />

      <RequireAuth>
        {(user) => <CouponsBody userId={user.id} initialTab={initialTab} />}
      </RequireAuth>
    </>
  );
}

async function CouponsBody({
  userId,
  initialTab,
}: {
  userId: string;
  initialTab: "owned" | "claimable";
}) {
  const params = new URLSearchParams();
  params.set("tab", initialTab);

  // 服务端首屏不注入 Mock 故障参数：一个查询参数就把整页打成错误页不是想要的调试体验
  const result = await queryCouponsForUser(userId, params, "server");

  // 返回的是「哪个 Tab 就是哪一份」的联合，这里按 Tab 分流即可，不需要类型断言
  const initial: CouponInitial =
    result.tab === "owned" ? { tab: "owned", page: result } : { tab: "claimable", page: result };

  return <CouponList initial={initial} />;
}
