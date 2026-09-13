import NavBar from "@/components/common/NavBar";
import SuggestionForm from "@/components/suggestions/SuggestionForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import { SUGGESTION_CREATE_PAGE_TITLE } from "@/lib/constants/suggestions";

/**
 * 我要反馈（需登录）。
 *
 * 二级页面：顶部返回、不带底部 TabBar；NavBar 在 `RequireAuth` 外面，
 * 未登录时也能返回上一页，登录后地址仍是 `/suggestions/new`。
 *
 * 本页**不预取任何数据**：表单只需要用户自己填的四项（类型、内容、联系方式、凭证），
 * 状态、回复、提交时间都由服务端在提交时写，因此这里没有任何「先读到客户端再传回去」的字段。
 * 提交成功后用 `router.replace` 回到 `/suggestions`（见 `SuggestionForm`）。
 */
export default function SuggestionCreatePage() {
  return (
    <>
      <NavBar title={SUGGESTION_CREATE_PAGE_TITLE} showBack />

      <RequireAuth>{() => <SuggestionForm />}</RequireAuth>
    </>
  );
}
