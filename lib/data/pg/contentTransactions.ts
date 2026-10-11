import { createHash } from "node:crypto";
import {
  contentActionFromEnabled,
  isContentImageUnchanged,
  isQuickEntryUnchanged,
} from "@/lib/constants/adminContent";
import {
  toAnnouncementAuditSnapshot,
  toBannerAuditSnapshot,
  toQuickEntryAuditSnapshot,
} from "@/lib/constants/adminAudit";
import { isSafePath } from "@/lib/constants/safePath";
import type { AdminAuditAction, AdminAuditSnapshot } from "@/lib/types/adminAudit";
import type {
  AdminAnnouncementProfilePatch,
  AdminBannerProfilePatch,
  AdminQuickEntryProfilePatch,
  ContentAnnouncementRecord,
  ContentBannerRecord,
  QuickEntryRecord,
} from "@/lib/types/content";
import type { AdminContentWriteOutcome } from "../adminContentTransaction";
import { buildAuditEntry, type AdminWriteContext } from "../adminWriteSupport";
import type { ContentWriteResult } from "../contentRepository";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { takeCreateReplayTx, takeReplayTx } from "./adminWriteTx";
import { createContentRepository } from "./contentRepository";
import { getPgExecutor, type PgQueryable } from "./executor";

/**
 * 首页运营内容管理端写闭包（**新建 / 编辑 / 启停 / 移除 × 公告 / Banner / 快捷入口**）
 * 的 PostgreSQL 事务 —— `lib/data/adminContentTransaction.ts` 里 12 个公开事务函数的
 * **等价翻译**（PROD-1E Wave C）。
 *
 * ## 这次翻译要闭合的那条缝
 *
 * 三组内容的写入入口只有一处（Mock 的伪事务），判据、审计动作、返回值都在那里定义。
 * 它与订单闭包共用一条跨领域不变式：
 *
 * > 运营内容的**业务写入**与它的那一条管理审计必须**同生共死**。
 *
 * Mock 靠「同一段无 `await` 的同步代码」成立。换成数据库之后，两件事各自是一条 SQL，
 * 中间必然让出执行权；若审计还写 `globalThis`，就会出现本仓反复拒绝的半套事务——
 * 那次事务一提交，进程内的账本已经把「管理员建过这条公告」记下来了。因此审计必须在
 * **同一个事务**里 `INSERT`（`appendAuditEntryTx`），审计失败则业务写入一起回滚。
 *
 * ## 与 Mock 的关系：**等价翻译**，不是重新设计（Hard Rule 2）
 *
 * 判定顺序、三种「成功」的口径（`changed` / `replayed`）、no-op 的判据、写入的字段集合、
 * 审计 before/after 快照**逐条对齐** `adminContentTransaction.ts`。业务规则一个字节都没改，
 * 规则的唯一真值源仍是：
 *
 * | 规则 | 落点 |
 * |---|---|
 * | 「这次编辑什么都没改」的判据 | `adminContent.ts` 的 `isContentImageUnchanged` / `isQuickEntryUnchanged` |
 * | 编辑该记哪个动作（启用状态变了就是启停） | `adminContent.ts` 的 `contentActionFromEnabled` |
 * | 快捷入口目标地址的安全校验 | `safePath.ts` 的 `isSafePath` |
 * | 审计记什么（before / after 的字段） | `adminAudit.ts` 的三个 `to*AuditSnapshot` |
 * | 幂等重放判定 | `adminWriteSupport.ts` 的 `evaluateReplay` / `evaluateCreateReplay`（经 `adminWriteTx`） |
 * | 三类记录各自的正文形状与「可编辑字段」 | `contentRepository.ts` 的 `ContentRepository` 方法签名 |
 *
 * ⚠️ 上面每一条都是 **import 来的**，本文件不复制它们的判据。红利的边界很清楚：
 * 只**编排**这些纯函数与仓储写入，一处分叉都不会被漏掉。
 *
 * ## 幂等账本要读**两次**（与 `pg/adminAuditTransactions.ts` 同一条设计）
 *
 * | 读 | 位置 | 职责 |
 * |---|---|---|
 * | **前置读** | 取锁**之前** | 只判 `conflict`——与 Mock 的报错优先级对齐 |
 * | **权威读** | 取锁**之后** | 判 `replay` 与 `conflict`——决定这次到底写不写 |
 *
 * 前置读为什么必要：Mock 把「键冲突」排在**一切业务判定之前**（每一步第一行都是
 * `takeReplay` / `takeCreateReplay`）。若把整段账本读推到锁后，一次「复用了别人的幂等键」
 * 就可能先撞上「目标不存在」或「已移除」，报出来的原因与 Mock 不同。前置读**只回答
 * `conflict`**，它读到的 `replay` **不被采信**（那会导向写入，必须留给权威读）。
 *
 * 权威读为什么必须在锁后：两个**同键**请求若都先读账本才决定要不要写，会双双读空、
 * 双双进入写入段，最后撞在 `admin_audit_entries_operation_key` 唯一索引上（`23505`）——
 * 那**不是重放，是一次失败**。排在竞争行锁之后，第二个请求会等待、等第一个提交之后再读账本，
 * 于是看到那一行、正确重放。
 *
 * ⚠️ 因此有两条**不可合并**的判据，别把前置读的结果直接当结论用。
 *
 * ## 新建**没有可锁的行**：`operationId` 派生的顾问锁
 *
 * 编辑 / 启停 / 移除都能把幂等判定挂在「这一行」上（`SELECT … FOR UPDATE`），
 * 而**新建没有这样一行**——目标 id 是在事务里当场生成的，两个并发的新建请求不存在
 * 任何共享的行可以串行化。若照搬「先读账本、再写」，两个**同键**的新建会双双读到空账本、
 * 双双 `INSERT`，第二个撞 `admin_audit_entries_operation_key`（`23505`）→ 两个请求都失败，
 * 而正确的答案是「你刚才已经建过了」。因此新建在**事务最前面**取一把由 `operationId` 派生的
 * 事务级顾问锁（`pg_advisory_xact_lock`），与 `pg/couponTemplateTransactions.ts` 同一个 idiom。
 *
 * ## 加锁顺序：这是一条**只锁自己那一行**的路径
 *
 * 全库统一的不变量是「`orders` 永远是第一把锁」（理由见 `w1Transactions.ts` 文件头）。
 * 本文件**三张内容表选其一、只锁一行**，不写订单、不写退款、不动任何金额，
 * 因此不与订单锁成环：
 *
 * | 事务 | 加锁顺序 |
 * |---|---|
 * | 公告 / Banner / 快捷入口的编辑·启停·移除（本文件） | **仅该内容表的那一行** |
 *
 * ⚠️ 既然不锁 `orders`，将来若有人在这里加一次「读订单」用来做别的判定，
 * **只允许普通读**（`SELECT`，不加 `FOR UPDATE`）——普通读不参与加锁顺序。
 * 今天这条路径连订单都不读。
 *
 * ## 本轮**不激活**
 *
 * 公开函数的**路由**（`DATA_SOURCE` 选择走 Mock 还是 Pg）在
 * `lib/data/adminContentTransaction.ts` 里做（D3「同文件内路由」）。`DATA_SOURCE`
 * 未设置时应用照旧走 Mock 伪事务，本模块的调用方**只有测试与路由**。
 *
 * ## 事务内**绝不**调 Mock 的 `writeAudit`
 *
 * `adminWriteSupport.ts` 的 `writeAudit` 末尾会写**进程内的** Mock 账本。
 * 这里复用同一个**拼装函数** `buildAuditEntry`（纯函数），把结果交给
 * `appendAuditEntryTx` 的 `INSERT`。拼装规则一字未改，因此「审计记了些什么」
 * 在两个存储上仍然只有一处定义。
 */

// ——————————————————————————— 三类内容的适配 ———————————————————————————

type ContentKind = "announcement" | "banner" | "quickEntry";

type ContentRecordOf = {
  announcement: ContentAnnouncementRecord;
  banner: ContentBannerRecord;
  quickEntry: QuickEntryRecord;
};

type ContentDraftOf = {
  announcement: AdminAnnouncementProfilePatch;
  banner: AdminBannerProfilePatch;
  quickEntry: AdminQuickEntryProfilePatch;
};

/**
 * 三类内容共有的「一次写入需要知道的全部事情」。
 *
 * Mock 用的是「`kind` 字符串 + 内部 `switch`/`if` 分派 + 若干 `as` 断言」
 * （见 `adminContentTransaction.ts` 的 `mapOf` / `snapshotOf` / `isUnchanged`）。
 * 这里改成**逐类一个适配对象**：每个字段都是**类型精确**的函数，因此
 * 「公告的记录传给 Banner 的写入器」这种错法在**编译期**就炸，而 Mock 靠运行期断言。
 * 两者行为完全一致——同一份输入、同一份输出，只是把断言从运行期挪到了编译期。
 *
 * ⚠️ `table` 是本文件内的**字面量**（每个适配对象各自写死），不是外部输入，
 * 因此拼进 `SELECT … FOR UPDATE` 的 SQL 里**不存在注入面**。
 */
type ContentAdapter<K extends ContentKind> = {
  readonly kind: K;
  /** 该内容类别的物理表名。锁定那一行时用（本文件内的常量） */
  readonly table: string;
  /** 新建记录 id 的前缀，与 `adminContentTransaction.ts` 的 `ID_PREFIX` 同源 */
  readonly prefix: string;
  /**
   * 该类别的「目标地址不安全」判定。**只有快捷入口有一个非空实现**——
   * Mock 只在 `quickEntry` 这一条上判 `isSafePath(path)`（见原文件两处 `kind === "quickEntry"`），
   * 公告 / Banner 的图片地址不由事务层判（那是服务层表单校验的事）。这里照抄同一口径：
   * 为 `null` 表示「这一类没有这道守卫」，而不是「守卫一定通过」。
   */
  readonly isPathUnsafe: ((draft: ContentDraftOf[K]) => boolean) | null;
  find(db: PgQueryable, id: string): Promise<ContentRecordOf[K] | null>;
  create(db: PgQueryable, record: ContentRecordOf[K]): Promise<ContentRecordOf[K]>;
  update(
    db: PgQueryable,
    id: string,
    draft: ContentDraftOf[K],
    at: string,
  ): Promise<ContentWriteResult<ContentRecordOf[K]> | null>;
  setEnabled(
    db: PgQueryable,
    id: string,
    enabled: boolean,
    at: string,
  ): Promise<ContentWriteResult<ContentRecordOf[K]> | null>;
  markRemoved(
    db: PgQueryable,
    id: string,
    at: string,
  ): Promise<ContentWriteResult<ContentRecordOf[K]> | null>;
  snapshot(record: ContentRecordOf[K]): AdminAuditSnapshot;
  isUnchanged(record: ContentRecordOf[K], draft: ContentDraftOf[K]): boolean;
};

const ANNOUNCEMENT: ContentAdapter<"announcement"> = {
  kind: "announcement",
  table: "announcements",
  prefix: "an_",
  // 公告没有「目标地址」这道守卫：图片地址由服务层表单校验负责（与 Mock 一致）
  isPathUnsafe: null,
  find: (db, id) => createContentRepository(db).findAnnouncementById(id),
  create: (db, record) => createContentRepository(db).createAnnouncement(record),
  update: (db, id, draft, at) =>
    createContentRepository(db).updateAnnouncement(id, { ...draft, at }),
  setEnabled: (db, id, enabled, at) =>
    createContentRepository(db).setAnnouncementEnabled(id, enabled, at),
  markRemoved: (db, id, at) => createContentRepository(db).markAnnouncementRemoved(id, at),
  snapshot: toAnnouncementAuditSnapshot,
  // 公告与 Banner 的正文形状相同，共用同一个「什么都没改」判据
  isUnchanged: isContentImageUnchanged,
};

const BANNER: ContentAdapter<"banner"> = {
  kind: "banner",
  table: "banners",
  prefix: "bn_",
  isPathUnsafe: null,
  find: (db, id) => createContentRepository(db).findBannerById(id),
  create: (db, record) => createContentRepository(db).createBanner(record),
  update: (db, id, draft, at) => createContentRepository(db).updateBanner(id, { ...draft, at }),
  setEnabled: (db, id, enabled, at) => createContentRepository(db).setBannerEnabled(id, enabled, at),
  markRemoved: (db, id, at) => createContentRepository(db).markBannerRemoved(id, at),
  snapshot: toBannerAuditSnapshot,
  isUnchanged: isContentImageUnchanged,
};

const QUICK_ENTRY: ContentAdapter<"quickEntry"> = {
  kind: "quickEntry",
  table: "quick_entries",
  prefix: "qe_",
  // 安全属性：`validateSafePath()` 挡的是 `javascript:` 与站外地址。
  // 与 Mock 一样，这道守卫必须在**写入的那一刻**成立——服务层那次校验发生在若干次
  // `await` 之前，中间隔着取会话、读请求体的时间。安全属性的守门函数可以重复，不可以缺失。
  isPathUnsafe: (draft) => !isSafePath(draft.path),
  find: (db, id) => createContentRepository(db).findQuickEntryById(id),
  create: (db, record) => createContentRepository(db).createQuickEntry(record),
  update: (db, id, draft, at) =>
    createContentRepository(db).updateQuickEntry(id, { ...draft, at }),
  setEnabled: (db, id, enabled, at) =>
    createContentRepository(db).setQuickEntryEnabled(id, enabled, at),
  markRemoved: (db, id, at) => createContentRepository(db).markQuickEntryRemoved(id, at),
  snapshot: toQuickEntryAuditSnapshot,
  isUnchanged: isQuickEntryUnchanged,
};

// ——————————————————————————— 事务内原语 ———————————————————————————

/**
 * 新建路径的顾问锁键 —— 由 `operationId` 派生。
 *
 * ⚠️ 与 `pg/couponTemplateTransactions.ts` 的 `couponCreateLockKey()` **逐字相同**，
 * 但那一份是**私有函数**、未导出，因此这里只能各写一份。它属于**事务层**而不是仓储层：
 * 它编码的是「新建这条路径上用什么把两个同键请求串行化」——那是本文件的事务策略，
 * 与任何一张业务表无关，不能被仓储复用或覆盖。
 *
 * 为什么是哈希而不是直接用 `operationId`：幂等键是字符串，而
 * `pg_advisory_xact_lock` 收 bigint。`sha256` 取前 8 字节压进 int64：同一个键永远得到
 * 同一个数（→ 同一把锁），不同键极大概率得到不同的数（→ 不同的锁）。两把**本该无关**的
 * 锁撞成同一个键时，两个新建只会互相等待一下然后各自完成——**碰撞无害**，
 * 因此不需要一张「幂等键 → 锁」的对照表。
 */
function contentCreateLockKey(operationId: string): bigint {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
}

/**
 * 锁定并读出**被修改的那一行**（含已移除的）。
 *
 * 两步、且**必须按这个顺序**：
 *
 * 1. `SELECT id … FOR UPDATE` 把这一行锁住——两个并发、**同键同目标**的请求在这里排成队，
 *    第二个会一直等到第一个提交；
 * 2. 再 `find` 把整行读出来——
 *    ⚠️ 这次读**不是多余的**：`FOR UPDATE` 只保证「从此刻起这一行不会被别人改」，
 *    它拿到的 `id` 不足以做后续判断，而已移除状态、字段现值都得从这一行取。
 *
 * ⚠️ 读到的必须是**锁下的那一份**，不能拿请求体或调用方手里那份快照去比：
 * 「已移除的还能不能编辑」要回答的是**数据库此刻**的状态，而调用方那份可能是几个
 * `await` 之前读的。
 */
async function lockContentRowTx<K extends ContentKind>(
  tx: PgQueryable,
  adapter: ContentAdapter<K>,
  id: string,
): Promise<ContentRecordOf[K] | null> {
  const locked = await tx.query<{ id: string }>(
    `SELECT id FROM ${adapter.table} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!locked[0]) return null;
  return adapter.find(tx, id);
}

// ——————————————————————————— 新建 ———————————————————————————

/**
 * 新建一条运营内容 —— Mock 的 `createContent()` 的 Pg 实现。
 *
 * 「同一个幂等键第二次到达」靠**操作类型**识别（`takeCreateReplayTx`），而不是靠目标 id：
 * 新建的目标 id 是在事务里当场生成的，第二次调用会生成一个不同的 id，按 id 比对只会
 * 把它误判成「幂等键被别的对象用了」。`takeCreateReplayTx` 只认「这个键已经被同类型的
 * 对象用过」，再拿审计里记下的 id 把当时那条记录找回来。
 *
 * ⚠️ **由此产生一条对调用方的要求：同一个幂等键只能用于一类动作**（与 Mock 原注释同）。
 * 服务层每次操作都用 `crypto.randomUUID()` 现取新键，真实路径不会撞上；但这是调用方的义务。
 *
 * ⚠️ 快捷入口的路径在**事务之前**再判一次（见 `isPathUnsafe`）：它是只读判断，
 * 不依赖事务内的任何状态，因此放在事务外不影响任何判定顺序。
 */
async function createContentPg<K extends ContentKind>(
  adapter: ContentAdapter<K>,
  draft: ContentDraftOf[K],
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  // 安全属性必须在写入前成立（Mock 在同一位置：原子区段之前）
  if (adapter.isPathUnsafe?.(draft)) return { kind: "invalid-path" };

  const action = `${adapter.kind}.create` as AdminAuditAction;

  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 第 1 步：顾问锁。新建没有行可锁，同键串行只能靠它 —— */
    // ⚠️ 必须排在**读账本之前**：排在之后，「双双读空、双双写入」的窗口就又回来了
    await tx.query("SELECT pg_advisory_xact_lock($1)", [contentCreateLockKey(ctx.operationId)]);

    /* —— 第 2 步：读账本（本路径里前置读与权威读合一，因为锁已经在最前面）—— */
    const replay = await takeCreateReplayTx(tx, ctx, adapter.kind);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay") {
      // 账本里有、记录却没有：数据被清过。宁可报「不存在」，也不照着账本编一条出来
      const existing = await adapter.find(tx, replay.targetId);
      if (!existing) return { kind: "not-found" };
      return {
        kind: "ok",
        value: { previous: null, updated: { ...existing }, action },
        changed: false,
        replayed: true,
      };
    }

    // 服务端字段在这里钉死：`id` 现取（前缀与 Mock 的 `ID_PREFIX` 同源），
    // 三个时间戳一个由 `ctx.at`、两个写死（新建时 `removedAt` 必然是 null）。
    // ⚠️ 与 Mock 的 `nextRecordId()` 不同：那个要求一个**同步**的 `taken()` 回调，
    //    而 Pg 判存在性是异步的。改成「主键冲突即硬失败」——见 `insertContentRow` 的说明，
    //    那恰好保住了「绝不覆盖既有记录」这条不变量。
    const created = {
      ...(draft as object),
      id: `${adapter.prefix}${crypto.randomUUID()}`,
      createdAt: ctx.at,
      updatedAt: ctx.at,
      removedAt: null,
    } as ContentRecordOf[K];

    const stored = await adapter.create(tx, created);

    // 审计与业务写入同一个提交点：审计失败 ⇒ 这条记录也回滚
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: adapter.kind,
        targetId: stored.id,
        before: null,
        after: adapter.snapshot(stored),
      }),
    );

    return {
      kind: "ok",
      value: { previous: null, updated: { ...stored }, action },
      changed: true,
      replayed: false,
    };
  });
}

// ——————————————————————————— 编辑 / 启停 / 移除 ———————————————————————————

/**
 * 编辑一条运营内容 —— Mock 的 `updateContent()` 的 Pg 实现。
 *
 * ## 判定顺序（与 Mock 逐条相同）
 *
 * ```
 * 1. 快捷入口目标地址不安全        → invalid-path（事务之前）
 * 2. 幂等键用在别的对象上          → operation-conflict（前置读）
 * 3. 取锁；目标不存在              → not-found
 * 4. 目标已移除                    → removed
 * 5. 权威读：重放                  → ok / changed:false, replayed:true
 * 6. 提交的值与现状一模一样        → ok / changed:false, replayed:false
 * 7. 覆盖式窄 UPDATE + 审计
 * ```
 *
 * ⚠️ 第 4 步的判据是**锁下读到的那一份记录**的 `removedAt`，不是请求体里的任何东西——
 * 一条刚被另一位管理员移除的内容，不会因为请求里没提到移除就还能改。
 */
async function updateContentPg<K extends ContentKind>(
  adapter: ContentAdapter<K>,
  id: string,
  draft: ContentDraftOf[K],
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  if (adapter.isPathUnsafe?.(draft)) return { kind: "invalid-path" };

  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict（Mock 把它排在存在性判定之前）—— */
    const pre = await takeReplayTx(tx, ctx, adapter.kind, id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这一条内容自己。判定与写入都围着这一行 —— */
    const existing = await lockContentRowTx(tx, adapter, id);
    if (!existing) return { kind: "not-found" };
    // 已移除的内容不再接受编辑：它已经不在用户端了，改名称与排序没有任何去向
    if (existing.removedAt !== null) return { kind: "removed" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, adapter.kind, id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    // 动作名由**锁下那一份**的启用状态与本次提交值算出（启用状态变了就是启停，否则编辑）。
    // ⚠️ 复用常量层的 `contentActionFromEnabled`，不在这里再写一遍三分支
    const action = contentActionFromEnabled(adapter.kind, existing.enabled, draft.enabled);

    // 两种「什么都没发生」都不写数据、不写审计、也不刷新时间戳，且**都不是错误**
    if (replay?.kind === "replay" || adapter.isUnchanged(existing, draft)) {
      return {
        kind: "ok",
        // 两份互不相关的副本，而不是同一个对象的两个别名
        value: { previous: { ...existing }, updated: { ...existing }, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await adapter.update(tx, id, draft, ctx.at);
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态；
    // 当作失败返回，绝不继续写审计（与 Mock 的 `if (!existing) return { kind: "not-found" }` 同）
    if (!written) return { kind: "not-found" };

    // 审计与业务写入同一个提交点：审计失败 ⇒ 这次编辑也回滚
    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: adapter.kind,
        targetId: id,
        before: adapter.snapshot(written.previous),
        after: adapter.snapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { previous: { ...written.previous }, updated: { ...written.updated }, action },
      changed: true,
      replayed: false,
    };
  });
}

/**
 * 启用 / 停用（窄写入：只改这一个字段）—— Mock 的 `setContentEnabled()` 的 Pg 实现。
 *
 * ⚠️ 与 `updateContentPg()` 分开，是因为它**不该碰名称、图片、排序**：
 * 列表页上的启用开关只应当改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的标题覆盖回旧值。
 *
 * ⚠️ 用 `takeReplayTx` 而不是 `takeReplayForActionTx`：本动作的**意图由入参决定**
 * （`enabled` 就是意图本身），同一个入参第二次到达本来就该是「重放」。取舍与
 * `setCouponTemplateEnabledPg()` 完全一致，不要「顺手改进」。
 */
async function setContentEnabledPg<K extends ContentKind>(
  adapter: ContentAdapter<K>,
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  const action = `${adapter.kind}.${enabled ? "enable" : "disable"}` as AdminAuditAction;

  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, adapter.kind, id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这一条内容自己 —— */
    const existing = await lockContentRowTx(tx, adapter, id);
    if (!existing) return { kind: "not-found" };
    if (existing.removedAt !== null) return { kind: "removed" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, adapter.kind, id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    // 已经就是那个状态：不写数据、不写审计、不刷新时间戳，且**不是错误**
    if (replay?.kind === "replay" || existing.enabled === enabled) {
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing }, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await adapter.setEnabled(tx, id, enabled, ctx.at);
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态（与 Mock 同处理）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: adapter.kind,
        targetId: id,
        before: adapter.snapshot(written.previous),
        after: adapter.snapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { previous: { ...written.previous }, updated: { ...written.updated }, action },
      changed: true,
      replayed: false,
    };
  });
}

/**
 * 软移除 —— Mock 的 `removeContent()` 的 Pg 实现。
 *
 * ⚠️ **不删记录**：与类目、商品同一个理由——已经发出去的内容事后要能回答
 * 「当时首页上那张图是什么」。真删了就只能靠猜。
 *
 * ⚠️ 幂等：已经移除的再移除一次**不刷新时间戳、不写审计**，返回 `changed: false`。
 * 这条幂等在 Pg 侧由两层共同保证：本函数锁下看到 `removedAt !== null` 时直接走 no-op；
 * 即便走到 `applyRemovedRow`，它也有一条「已移除不刷新时间戳」的幂等分支。
 *
 * ⚠️ 与编辑 / 启停不同，移除**没有** `removed` 这一条失败分支——对已经移除的记录再移除
 * 一次是**幂等成功**而不是错误（与 Mock 同一口径）。
 */
async function removeContentPg<K extends ContentKind>(
  adapter: ContentAdapter<K>,
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  const action = `${adapter.kind}.remove` as AdminAuditAction;

  return getPgExecutor().withTransaction(async (tx) => {
    /* —— 前置读：只判 conflict —— */
    const pre = await takeReplayTx(tx, ctx, adapter.kind, id);
    if (pre?.kind === "conflict") return { kind: "operation-conflict" };

    /* —— 取锁：这一条内容自己 —— */
    const existing = await lockContentRowTx(tx, adapter, id);
    if (!existing) return { kind: "not-found" };

    /* —— 权威读：锁下重读账本，这一次的 replay 才作数 —— */
    const replay = await takeReplayTx(tx, ctx, adapter.kind, id);
    if (replay?.kind === "conflict") return { kind: "operation-conflict" };

    if (replay?.kind === "replay" || existing.removedAt !== null) {
      return {
        kind: "ok",
        value: { previous: { ...existing }, updated: { ...existing }, action },
        changed: false,
        replayed: replay?.kind === "replay",
      };
    }

    const written = await adapter.markRemoved(tx, id, ctx.at);
    // 上面刚在锁下确认过记录存在，这里为 null 属于不可能状态（与 Mock 同处理）
    if (!written) return { kind: "not-found" };

    await appendAuditEntryTx(
      tx,
      buildAuditEntry({
        ctx,
        action,
        targetType: adapter.kind,
        targetId: id,
        before: adapter.snapshot(written.previous),
        after: adapter.snapshot(written.updated),
      }),
    );

    return {
      kind: "ok",
      value: { previous: { ...written.previous }, updated: { ...written.updated }, action },
      changed: true,
      replayed: false,
    };
  });
}

// ——————————————————————————— 公开入口（12 个） ———————————————————————————

/*
 * ⚠️ 下面 12 个公开函数**不抽成一个泛型工厂**，与 Mock 的裁定完全相同：
 * 抽了之后签名会变成 `xxxContentPg<K>(kind, ...)`，而「哪一组内容走哪一条路径」
 * 就从**函数名**退化成一次**字符串参数**——一个拼错的 kind 在运行期才炸，
 * 而拼错的函数名编译期就炸。三组内容各自只有四个函数，写全比省下这几十行更值。
 */

/** 新建图片公告 —— `createAnnouncement` 的 Pg 实现。 */
export function createAnnouncementPg(
  draft: AdminAnnouncementProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return createContentPg(ANNOUNCEMENT, draft, ctx);
}

/** 编辑图片公告（标题 / 图片 / 说明 / 排序 / 启用状态一起提交）。 */
export function updateAnnouncementPg(
  id: string,
  draft: AdminAnnouncementProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return updateContentPg(ANNOUNCEMENT, id, draft, ctx);
}

/** 启用 / 停用图片公告。 */
export function setAnnouncementEnabledPg(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return setContentEnabledPg(ANNOUNCEMENT, id, enabled, ctx);
}

/** 软移除图片公告。 */
export function removeAnnouncementPg(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return removeContentPg(ANNOUNCEMENT, id, ctx);
}

/** 新建活动 Banner。 */
export function createBannerPg(
  draft: AdminBannerProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return createContentPg(BANNER, draft, ctx);
}

/** 编辑活动 Banner。 */
export function updateBannerPg(
  id: string,
  draft: AdminBannerProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return updateContentPg(BANNER, id, draft, ctx);
}

/** 启用 / 停用活动 Banner。 */
export function setBannerEnabledPg(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return setContentEnabledPg(BANNER, id, enabled, ctx);
}

/** 软移除活动 Banner。 */
export function removeBannerPg(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return removeContentPg(BANNER, id, ctx);
}

/** 新建快捷入口。目标地址在事务之前会被再校验一次。 */
export function createQuickEntryPg(
  draft: AdminQuickEntryProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return createContentPg(QUICK_ENTRY, draft, ctx);
}

/** 编辑快捷入口。目标地址在事务之前会被再校验一次。 */
export function updateQuickEntryPg(
  id: string,
  draft: AdminQuickEntryProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return updateContentPg(QUICK_ENTRY, id, draft, ctx);
}

/** 启用 / 停用快捷入口。 */
export function setQuickEntryEnabledPg(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return setContentEnabledPg(QUICK_ENTRY, id, enabled, ctx);
}

/** 软移除快捷入口。 */
export function removeQuickEntryPg(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return removeContentPg(QUICK_ENTRY, id, ctx);
}
