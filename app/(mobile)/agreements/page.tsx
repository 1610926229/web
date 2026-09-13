import NavBar from "@/components/common/NavBar";
import AgreementTabs from "@/components/agreements/AgreementTabs";
import { AGREEMENT_PAGE_TITLE } from "@/lib/constants/agreements";
import { listAgreements } from "@/lib/services/agreements";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 相关协议与版本介绍（**游客可访问**）。
 *
 * 二级页面：在 `(tabs)` 之外，顶部返回、**不带底部 TabBar**。
 *
 * 这里**不用 `RequireAuth`**，也不读会话：协议是公开内容，登录与否看到的是同一份数据。
 * 不收用户身份，也就没有可以泄漏的用户数据。
 *
 * 正文全部来自服务端数据层（Mock 期间是 `lib/mocks/fixtures/agreementSeed.ts`），
 * 页面**不写死任何条款文本**：将来管理者在 PC 管理后台改配置，这里跟着变。
 * Mock 文案里凡是平台主体信息的位置都是明显的占位变量，不含任何编造的公司名称、
 * 地址、电话或统一社会信用代码。
 *
 * Mock 参数原样传下去：`?mockEmpty=agreements` 演示「内容暂未配置」。
 */
export default async function AgreementsPage({ searchParams }: PageProps<"/agreements">) {
  const params = toSearchParams(await searchParams);
  const dto = await listAgreements(params, "server");

  return (
    <>
      <NavBar title={AGREEMENT_PAGE_TITLE} showBack />
      <AgreementTabs dto={dto} />
    </>
  );
}
