import NavBar from "@/components/common/NavBar";
import ReviewList, { type ReviewInitial } from "@/components/reviews/ReviewList";
import RequireAuth from "@/lib/auth/RequireAuth";
import { parseReviewListQuery } from "@/lib/constants/reviews";
import { queryReviewsForUser } from "@/lib/services/reviews";
import type { ReviewRange, ReviewTabKey } from "@/lib/types/review";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 我的评价（需登录）。
 *
 * 二级页面：在 `(tabs)` 之外，用顶部返回、**不带底部 TabBar**。
 * NavBar 放在 `RequireAuth` 外面，未登录时也能返回上一页，登录后地址仍是 `/reviews`。
 *
 * 首屏只取**当前 Tab + 当前时间范围**那一页（地址里的 `?tab=` / `?range=` 决定），
 * 其余组合由客户端按需取：首屏取多份会让「加载中 / 空 / 出错重试」这几个状态永远看不到。
 * 切 Tab、换时间范围、加载更多都由 `ReviewList` 以浏览器请求完成，两条链路共用
 * `lib/services/reviews.ts` 的同一个函数，取数口径只有一套。
 *
 * 地址里的 Tab / 时间筛选取值非法时**在页面这一层忽略掉、按默认展示**：页面地址是用户
 * 随手可改的，不该因此把整页变成错误页；接口收到非法取值则返回 400。
 */
export default async function ReviewsPage({ searchParams }: PageProps<"/reviews">) {
  const query = toSearchParams(await searchParams);
  const parsed = parseReviewListQuery(query);

  const tab: ReviewTabKey = parsed.ok ? parsed.query.tab : "reviewed";
  const range: ReviewRange = parsed.ok ? parsed.query.range : "all";

  return (
    <>
      <NavBar title="我的评价" showBack />

      <RequireAuth>
        {(user) => <ReviewsBody userId={user.id} tab={tab} range={range} />}
      </RequireAuth>
    </>
  );
}

async function ReviewsBody({
  userId,
  tab,
  range,
}: {
  userId: string;
  tab: ReviewTabKey;
  range: ReviewRange;
}) {
  const params = new URLSearchParams();
  params.set("tab", tab);
  params.set("range", range);

  // 服务端首屏不注入 Mock 故障参数：一个查询参数就把整页打成错误页不是想要的调试体验
  const result = await queryReviewsForUser(userId, params, "server");

  // 返回的是「哪个 Tab 就是哪一份」的联合，这里按 Tab 分流即可，不需要类型断言
  const initial: ReviewInitial =
    result.tab === "reviewed"
      ? { tab: "reviewed", range, page: result }
      : { tab: "pending", range, page: result };

  return <ReviewList initial={initial} />;
}
