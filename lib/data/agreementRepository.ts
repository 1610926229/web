import type { Agreement, AgreementSection } from "@/lib/types/agreement";
import { mockAgreementRepository } from "./mockAgreementRepository";

/**
 * 协议与版本介绍的可替换仓储。
 *
 * ## 读与写的分工（P8E-1 起）
 *
 * 用户端协议页与管理后台读的是**同一个仓储、同一份记录**，因此「后台改完正文，
 * 用户端刷新就是新的」不是靠任何同步动作做到的。这一点与商品目录、
 * 首页运营内容是同一套结构。
 *
 * ⚠️ **写方法只服务管理端**：每一个走到这里的写请求都先经过 `requireAdmin()`
 * （见 `app/api/admin/content/agreements/**`）。用户端那一侧至今没有任何写入口，
 * 也不该有——协议是公开内容，普通用户、客服与护航都只能查看。
 *
 * ⚠️ **没有新建、也没有删除**：协议类型是固定枚举（用户 / 隐私 / 陪玩 / 平台 / 版本），
 * 每个类型有且只有一条记录，前台五个页签永远都在。因此这里既没有 `createXxx()`，
 * 也没有 `markXxxRemoved()`——本阶段根本没有「删掉一份协议」这项能力，
 * 要下架一份协议是把它**停用**（可逆），而不是把记录去掉。
 *
 * ## 仓储与业务规则的分工
 *
 * 本层只负责**存取**，**不判断**下面这些事：
 *
 * - 「哪一版是当前版本」「停用的不展示」——那是 `lib/constants/agreements.ts`
 *   的 `pickCurrentAgreements()`，用户端与管理端读的是同一条规则。
 * - 「正文多长、能不能为空、有没有 HTML」——那是
 *   `lib/constants/adminAgreements.ts`，由服务层与事务层调用。
 * - 「版本号要不要递增」——那不是仓储的事：仓储收到的 `version` 已经是
 *   **算好的值**（见下面 `updateAgreement()` 的说明）。
 *
 * ## 读方法的两种口径
 *
 * `listAgreements()` 一律返回**全部记录（含停用与历史版本）**，不做任何过滤：
 * 后台要能看见用户端看不见的那些（停用的那条必须能被重新启用），
 * 而用户端的可见性规则在纯函数里，两者都在同一份原始数据上做各自的事。
 */
export type AgreementRepository = {
  /** 全部协议记录，含停用项与历史版本。顺序不做保证。 */
  listAgreements(): Promise<Agreement[]>;

  /**
   * 按 id 取一条协议，**含已停用的**。
   *
   * ⚠️ 只有管理端这一个调用方：用户端从不按 id 取协议，它拿的是
   * `buildAgreementsDto()` 组装好的「每类一份当前启用版本」。
   * 因此这里不需要像商品目录那样拆成「用户端详情 / 后台详情」两个方法——
   * 真出现第二个消费方时再加，而不是先预备一个没有调用点的窄方法。
   */
  findAgreementById(id: string): Promise<Agreement | null>;

  /**
   * 覆盖式更新一条协议。
   *
   * ⚠️ `patch.version` 是**调用方算好的**，不是仓储自己递增的：版本号只在
   * 「标题或正文真的变了」时才推进，而「变没变」这个判断必须与写入发生在
   * 同一个原子区段里（见 `lib/data/adminAgreementTransaction.ts`）。
   * 仓储自己去 bump 的话，一次「内容没改」的保存也会把版本推高一格。
   *
   * ⚠️ `type` 与 `id` **不在 patch 里**：它们是记录的身份。类型是固定枚举，
   * 改类型等于换了一份协议，那不是编辑。
   *
   * 记录不存在返回 null。返回改动前后的**两份副本**：审计快照需要 before/after
   * 两份，而 before 必须在写入前取到——写完之后再去读，读到的已经是新值了。
   */
  updateAgreement(id: string, patch: AgreementPatch): Promise<AgreementWriteResult | null>;

  /**
   * 只改启用状态（启用 / 停用走同一条路径）。
   *
   * ⚠️ 单独开一个窄写入器，而不是复用 `updateAgreement()`：后台列表上的
   * 「停用」按钮只应当改这一个字段，**绝不能**顺带把标题和正文写回去——
   * 那需要调用方先把整条记录读出来再拼一个完整 patch，而那份读取发生在原子区段之外，
   * 两位管理员同时操作时后写入的那次会把另一位刚改好的正文覆盖回旧值。
   *
   * ⚠️ 这条路径**不动 `version`**：启用状态不是正文的版本。
   */
  setAgreementEnabled(
    id: string,
    enabled: boolean,
    at: string,
  ): Promise<AgreementWriteResult | null>;
};

/**
 * 一次协议写入的返回：改动前后的记录。
 *
 * ⚠️ 与商品目录、运营内容的 `{ previous, updated } | null` 保持同一形状。
 * 这里的 `previous` 不是 `null`（协议没有新建），但**不因此收窄成非空类型**：
 * 三个模块的伪事务返回值在服务层被同一套代码处理，形状一致比省一个判空更值。
 */
export type AgreementWriteResult = { previous: Agreement; updated: Agreement };

/**
 * 仓储层能改的字段 + 服务端时间戳。
 *
 * 时间戳由调用方传入而不是仓储自己取 `new Date()`：业务写入与审计写入必须
 * 共用**同一个** `at`（见 `lib/data/adminWriteSupport.ts` 的 `AdminWriteContext`），
 * 仓储自己取时间会让两者差几毫秒，而审计的意义正是「这一刻发生了什么」。
 */
export type AgreementPatch = {
  title: string;
  sections: AgreementSection[];
  version: string;
  enabled: boolean;
  /** 服务端时间戳（ISO 字符串），同时写进 `updatedAt` */
  at: string;
};

export function getAgreementRepository(): AgreementRepository {
  return mockAgreementRepository;
}
