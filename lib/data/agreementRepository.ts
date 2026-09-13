import type { Agreement } from "@/lib/types/agreement";
import { mockAgreementRepository } from "./mockAgreementRepository";

/**
 * 协议与版本介绍的可替换仓储 —— **只读**。
 *
 * ⚠️ 这里**故意没有任何写入方法**：协议正文只有管理者在未来 PC 管理后台可以修改，
 * 普通用户只能查看。因此这一侧只提供读取，将来管理端的写入口是另建的一条链路
 * （带管理端鉴权），不会与用户端读接口混在一起。
 *
 * 读取侧返回**全部记录（含停用项与历史版本）**：「只展示启用内容」「同类型只返回当前
 * 启用版本」都是业务规则，由 `lib/constants/agreements.ts` 决定。仓储不替调用方筛选，
 * 否则「取哪一版」会在仓储与页面里各有一份实现。
 */
export type AgreementRepository = {
  /** 全部协议记录，含停用项与历史版本。顺序不做保证。 */
  listAgreements(): Promise<Agreement[]>;
};

export function getAgreementRepository(): AgreementRepository {
  return mockAgreementRepository;
}
