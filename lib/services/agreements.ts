import { buildAgreementsDto } from "@/lib/constants/agreements";
import { getAgreementRepository } from "@/lib/data/agreementRepository";
import { withMockEmptyDebug, type MockSurface } from "@/lib/mocks/debug";
import type { AgreementsDto } from "@/lib/types/agreement";

/**
 * 协议与版本介绍服务 —— **只读**，且**不要求登录**。
 *
 * 协议是公开内容，游客与登录用户看到的是同一份数据，因此这里**没有 userId 参数**：
 * 不收，也就不会有人拿它去查别人的东西。
 *
 * ⚠️ 本文件**没有、也不应该有**任何写入函数。协议正文将来只有管理者能在 PC 管理后台修改，
 * 本阶段只完成用户端读取与 Mock 数据访问层。提前开一个写入口，就等于顺带定下了
 * 「谁能改、改了要不要留痕、旧版本怎么处理」这些必须先与业务确认的事。
 *
 * 版本选择、停用过滤与字段挑选全部在 `buildAgreementsDto` 里完成；本函数只负责取数据，
 * 因此页面拿到的永远是「每类一条、已启用、版本最高」的内容。
 */

/**
 * 取全部协议页签内容。
 *
 * 五类固定都返回：某一类没有可用内容时该页签的 `agreement` 为 null，
 * 由页面显示「内容暂未配置」。**不会因为缺一类就让整个接口失败**——
 * 那会把「一类没配置」放大成「整个协议页打不开」。
 */
export async function listAgreements(
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AgreementsDto> {
  // `?mockEmpty=agreements` 用于验收「某一类未配置」：预置数据里五类齐全，
  // 不注入就没有「内容暂未配置」可看。
  const records = await withMockEmptyDebug(params, surface, "agreements", () =>
    getAgreementRepository().listAgreements(),
  );

  return buildAgreementsDto(records);
}
