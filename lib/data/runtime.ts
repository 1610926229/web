import { adminAuditRepositoryBacking } from "./adminAuditRepository";
import { adminRepositoryBacking } from "./adminRepository";
import { agreementRepositoryBacking } from "./agreementRepository";
import { catalogRepositoryBacking } from "./catalogRepository";
import { companionAcceptRepositoryBacking } from "./companionAcceptRepository";
import { companionApplicationRepositoryBacking } from "./companionApplicationRepository";
import { companionReleaseRepositoryBacking } from "./companionReleaseRepository";
import { companionRepositoryBacking } from "./companionRepository";
import { companionServiceRepositoryBacking } from "./companionServiceRepository";
import { complaintRepositoryBacking } from "./complaintRepository";
import { completionRepositoryBacking } from "./completionRepository";
import { contentRepositoryBacking } from "./contentRepository";
import { couponRepositoryBacking } from "./couponRepository";
import { assertAllRepositoriesWired, CORE_REPOSITORY_COUNT } from "./datasource";
import { dispatchRepositoryBacking } from "./dispatchRepository";
import { earningRepositoryBacking } from "./earningRepository";
import { favoriteRepositoryBacking } from "./favoriteRepository";
import { levelRepositoryBacking } from "./levelRepository";
import { messageRepositoryBacking } from "./messageRepository";
import { notificationRepositoryBacking } from "./notificationRepository";
import { paymentRepositoryBacking } from "./paymentRepository";
import { platformConfigRepositoryBacking } from "./platformConfigRepository";
import { qualificationRepositoryBacking } from "./qualificationRepository";
import { refundRepositoryBacking } from "./refundRepository";
import { reviewRepositoryBacking } from "./reviewRepository";
import { staffRepositoryBacking } from "./staffRepository";
import { suggestionRepositoryBacking } from "./suggestionRepository";
import { tipRepositoryBacking } from "./tipRepository";
import { userRepositoryBacking } from "./userRepository";

/**
 * 核心仓储的**完整清单**（PROD-1E · Phase 6）。
 *
 * ## 为什么要有这个文件
 *
 * 「28 个仓储都有 Pg 实现」是一句**关于整个代码库**的话。写成注释，它会随着
 * 新增一个域而**悄悄变成假话**——没有人会记得回来改注释。写成这里的一份清单，
 * 它就是一个可以在运行时被检查的对象：`assertAllRepositoriesWired` 逐个看 `pg`
 * 是不是 `null`，再看条数是不是 `CORE_REPOSITORY_COUNT`。
 *
 * 这正是把「有没有 Pg 实现」从**隐式的代码分支**（每个访问器自己 `?:` 选一下）
 * 变成**可枚举的数据**所换来的东西：漏掉一个域不再是「某条路径悄悄走了 Mock」，
 * 而是启用 PostgreSQL 时**当场抛错**，并且一次列出**全部**缺的域。
 *
 * ## 这份清单不会自己更新，这是刻意的
 *
 * 新增第 29 个仓储时，这里要加一行 import、加一项，并且 `CORE_REPOSITORY_COUNT`
 * 要一起改。这三处漏掉任何一处，`DATA_SOURCE=postgres` 下都会抛错。
 * 「自动发现」看起来更省事，但它会连**忘记写 Pg 实现**一起自动发现——
 * 而那个才是要拦的东西。
 *
 * ⚠️ **Mock 模式下这份检查一次都不跑**（理由见 `datasource.ts` 的文件头）：
 * 那样会让一次「清单漏登记」变成开发环境起不来，属于与本次改动无关的行为变更。
 * 代价是既有测试覆盖不到这两个断言，已登记在 `03-delivery.md`。
 */

/** 全部核心仓储。顺序按域名的字母序，与上面的 import 一致。 */
const ALL_REPOSITORY_BACKINGS = [
  adminAuditRepositoryBacking,
  adminRepositoryBacking,
  agreementRepositoryBacking,
  catalogRepositoryBacking,
  companionAcceptRepositoryBacking,
  companionApplicationRepositoryBacking,
  companionReleaseRepositoryBacking,
  companionRepositoryBacking,
  companionServiceRepositoryBacking,
  complaintRepositoryBacking,
  completionRepositoryBacking,
  contentRepositoryBacking,
  couponRepositoryBacking,
  dispatchRepositoryBacking,
  earningRepositoryBacking,
  favoriteRepositoryBacking,
  levelRepositoryBacking,
  messageRepositoryBacking,
  notificationRepositoryBacking,
  paymentRepositoryBacking,
  platformConfigRepositoryBacking,
  qualificationRepositoryBacking,
  refundRepositoryBacking,
  reviewRepositoryBacking,
  staffRepositoryBacking,
  suggestionRepositoryBacking,
  tipRepositoryBacking,
  userRepositoryBacking,
] as const;

/**
 * 清单条数必须与 `CORE_REPOSITORY_COUNT` 相等——**进程加载期**就检查一次，
 * 而不是等到有人调用 `getDataSource()`。
 *
 * 这一条**不分数据源模式**：它检查的是本文件与 `datasource.ts` 这两个常量是否自洽，
 * 与「跑在 Mock 还是 Pg 上」无关。漏掉它的话，一份少了一行的清单在 Mock 模式下
 * 会一直看起来正常，直到有人切到 PostgreSQL 才发现——而那时要排查的是「为什么
 * 有一张表没数据」，比一条加载期的错误信息贵得多。
 */
if (ALL_REPOSITORY_BACKINGS.length !== CORE_REPOSITORY_COUNT) {
  throw new Error(
    `lib/data/runtime.ts 的仓储清单有 ${ALL_REPOSITORY_BACKINGS.length} 条，` +
      `但 CORE_REPOSITORY_COUNT = ${CORE_REPOSITORY_COUNT}。新增或删除仓储时两处必须一起更新。`,
  );
}

let asserted = false;

/**
 * 首次调用时跑一次全量检查，之后不再重复。
 *
 * ⚠️ 「只跑一次」是有意的：`assertAllRepositoriesWired` 的结论**不随请求变化**
 * （它读的是模块级常量与环境变量），每次请求重算一遍没有意义。同时它**不缓存
 * 失败**——第一次抛错之后进程通常已经不该继续服务了，而下一次调用会再抛一次，
 * 不会变成「第一次报错、之后静默返回 Mock」。
 */
export function assertRepositoriesReadyOnce(): void {
  if (asserted) return;
  assertAllRepositoriesWired(ALL_REPOSITORY_BACKINGS);
  asserted = true;
}

/** 仅供测试使用：让下一次调用重新跑一遍检查。 */
export function resetRepositoriesReadyAssertion(): void {
  asserted = false;
}
