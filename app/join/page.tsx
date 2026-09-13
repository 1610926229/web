import NavBar from "@/components/common/NavBar";
import PlaceholderPage from "@/components/common/PlaceholderPage";
import RequireAuth from "@/lib/auth/RequireAuth";

/**
 * 成为护航（考核入驻）。**进入前必须登录**。
 *
 * 两个入口都指向这里：首页「考核入驻」与「我的」页「成为护航」——
 * 同一个功能只留一个地址（首页曾经指向 `/placeholder` 的 `title` 查询参数写法）。
 * 未登录时由统一的 `RequireAuth` 渲染登录引导，地址保持 `/join` 不变，
 * 登录成功后服务端重新渲染本页，用户直接落在这里，不会被弹回首页。
 *
 * 导航栏渲染在鉴权**之外**：未登录时也要有返回入口，不能把人困在登录页上。
 * 本页在 `(tabs)` 之外，属于二级页面，因此只有顶部返回、没有底部 TabBar。
 *
 * 入驻申请与考核流程属于后续阶段，本阶段只有占位内容，不自行编造申请条件与佣金规则；
 * 服务端将来的入驻申请接口需要**单独鉴权**，当前尚未开发，这里不提前创建。
 */
export default function JoinPage() {
  return (
    <>
      <NavBar title="成为护航" showBack />

      <RequireAuth>
        <PlaceholderPage
          showNav={false}
          title="成为护航"
          description="入驻申请与考核流程待后续阶段实现，本阶段仅保留首页「考核入驻」与「我的」页「成为护航」两个入口，不自行编造申请条件、考核标准与佣金规则。"
        />
      </RequireAuth>
    </>
  );
}
