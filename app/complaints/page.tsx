import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import ComplaintList from "@/components/complaints/ComplaintList";
import RequireAuth from "@/lib/auth/RequireAuth";
import { parseComplaintStatus, type ComplaintTabKey } from "@/lib/constants/complaints";
import { queryComplaintsForUser } from "@/lib/services/complaints";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 投诉记录页（需登录）。
 *
 * 取数与交互的分工与订单列表一致：首屏由本页在服务端直接取（不 HTTP 请求自己的接口），
 * 切筛选与加载更多由 `ComplaintList` 以浏览器请求完成，两条链路共用
 * `lib/services/complaints.ts` 的同一个函数，筛选口径只有一套。
 *
 * 地址里的状态取值非法时**在页面这一层忽略掉、按「全部」展示**：页面地址是用户随手可改的，
 * 不该因此把整页变成错误页；接口收到非法状态则返回 400（见 `queryComplaintsForUser`）。
 *
 * 这一页在 `(tabs)` 之外（原型里投诉页是二级页面）：用顶部返回而不是底部 TabBar。
 * NavBar 放在 `RequireAuth` 外面，未登录时也能返回上一页。
 */
export default async function ComplaintsPage({ searchParams }: PageProps<"/complaints">) {
  const query = toSearchParams(await searchParams);
  const parsed = parseComplaintStatus(query.get("status"));
  const initialStatus: ComplaintTabKey = parsed && parsed !== "invalid" ? parsed : "all";

  return (
    <>
      <NavBar
        title="投诉记录"
        showBack
        right={
          <Link
            href="/complaints/new"
            aria-label="提交投诉"
            className="seg-tab-active flex h-8 w-8 items-center justify-center rounded-full text-[18px] leading-none"
          >
            ＋
          </Link>
        }
      />

      <RequireAuth>
        {(user) => <ComplaintsBody userId={user.id} initialStatus={initialStatus} />}
      </RequireAuth>
    </>
  );
}

async function ComplaintsBody({
  userId,
  initialStatus,
}: {
  userId: string;
  initialStatus: ComplaintTabKey;
}) {
  const params = new URLSearchParams();
  if (initialStatus !== "all") params.set("status", initialStatus);

  const result = await queryComplaintsForUser(userId, params, "server");

  return <ComplaintList initialStatus={initialStatus} initialResult={result} />;
}
