import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import TipList from "@/components/tips/TipList";
import RequireAuth from "@/lib/auth/RequireAuth";
import { TIP_PAGE_TITLE, parseTipListQuery } from "@/lib/constants/tips";
import { queryTipsForUser } from "@/lib/services/tips";
import type { TipStatusFilter } from "@/lib/types/tip";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 鸡腿记录（需登录，**只读**）。
 *
 * 二级页面：在 `(tabs)` 之外，用顶部返回、**不带底部 TabBar**。
 * NavBar 放在 `RequireAuth` 外面，未登录时也能返回上一页，登录后地址仍是 `/tips`。
 * 右上角的 ＋ 是原型里的新增入口，进入 `/tips/new`——**那一页本阶段不能提交**
 * （价格、支付与结算规则还没确认）。
 *
 * 首屏只取**当前筛选状态**那一页（地址里的 `?status=` 决定），其余状态由客户端按需取：
 * 首屏取多份会让「加载中 / 空 / 出错重试」这几个状态永远看不到。切换筛选与加载更多由
 * `TipList` 以浏览器请求完成，两条链路共用 `lib/services/tips.ts` 的同一个函数。
 *
 * 地址里的状态取值非法时**在页面这一层忽略掉、按「全部」展示**：页面地址是用户随手可改的，
 * 不该因此把整页变成错误页；接口收到非法取值则返回 400。
 */
export default async function TipsPage({ searchParams }: PageProps<"/tips">) {
  const query = toSearchParams(await searchParams);
  const parsed = parseTipListQuery(query);
  const initialStatus: TipStatusFilter = parsed.ok ? parsed.query.status : "all";

  return (
    <>
      <NavBar
        title={TIP_PAGE_TITLE}
        showBack
        right={
          <Link
            href="/tips/new"
            aria-label="送鸡腿（规则待确认）"
            className="seg-tab-active flex h-8 w-8 items-center justify-center rounded-full text-[18px] leading-none"
          >
            ＋
          </Link>
        }
      />

      <RequireAuth>
        {(user) => <TipsBody userId={user.id} initialStatus={initialStatus} />}
      </RequireAuth>
    </>
  );
}

async function TipsBody({
  userId,
  initialStatus,
}: {
  userId: string;
  initialStatus: TipStatusFilter;
}) {
  const params = new URLSearchParams();
  params.set("status", initialStatus);

  // 服务端首屏不注入 Mock 故障参数：一个查询参数就把整页打成错误页不是想要的调试体验
  const result = await queryTipsForUser(userId, params, "server");

  return <TipList initialStatus={initialStatus} initialResult={result} />;
}
