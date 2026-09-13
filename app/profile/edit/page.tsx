import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import ProfileEditForm from "@/components/profile/ProfileEditForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import { getUserProfile } from "@/lib/services/profile";

/**
 * 编辑资料页（需登录）。
 *
 * 二级页面：在 `(tabs)` 之外，因此用顶部返回导航、**不带底部 TabBar**（与原型一致）。
 * NavBar 放在 `RequireAuth` 外面，未登录时也能返回上一页。
 *
 * 初始值由服务端取（不 HTTP 请求自己的接口）。用户身份来自会话，页面不接受任何地址参数，
 * 因此 `/profile/edit` 只能是「编辑我自己的资料」；写入时服务端再按会话鉴权一次。
 *
 * 这里不注入 Mock 故障参数：服务端首屏被查询参数打成错误页没有调试价值，
 * 故障注入只在浏览器端请求（保存动作）时生效。
 */
export default function ProfileEditPage() {
  return (
    <>
      <NavBar title="编辑资料" showBack />

      <RequireAuth>
        {(user) => <ProfileEditBody userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function ProfileEditBody({ userId }: { userId: string }) {
  const profile = await getUserProfile(userId, undefined, "server");

  if (!profile) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <EmptyState
          title="资料暂不可用"
          description="当前账号的用户资料不存在，可在设置页退出登录后重新登录。"
        />
      </div>
    );
  }

  return <ProfileEditForm initialProfile={profile} />;
}
