import {
  isContentImageUnchanged,
  isQuickEntryUnchanged,
} from "@/lib/constants/adminContent";
import {
  toAnnouncementAuditSnapshot,
  toBannerAuditSnapshot,
  toQuickEntryAuditSnapshot,
} from "@/lib/constants/adminAudit";
import { isSafePath } from "@/lib/constants/safePath";
import type { AdminAuditAction, AdminAuditTargetType } from "@/lib/types/adminAudit";
import type {
  AdminAnnouncementProfilePatch,
  AdminBannerProfilePatch,
  AdminQuickEntryProfilePatch,
  ContentAnnouncementRecord,
  ContentBannerRecord,
  QuickEntryRecord,
} from "@/lib/types/content";
import { contentStore } from "./mockContentRepository";
import {
  nextRecordId,
  takeCreateReplay,
  takeReplay,
  writeAudit,
  type AdminWriteCommonFailure,
  type AdminWriteContext,
} from "./adminWriteSupport";

/**
 * 首页运营内容写操作的**伪事务** —— 本阶段所有图片公告、活动 Banner 与快捷入口
 * 改动的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * 「重复或并发请求不得产生重复实体或审计」这条要求横跨「业务记录」与「审计」两张表，
 * 仓库里没有事务可用，于是这里用一件事替代：**把读—判断—写的全过程放进一段
 * 没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「同一个幂等键新建公告」请求，第二个进来时第一个已经全部写完，
 * 它读到的是**已经存在**的审计记录，于是走重放路径而不是又建一条。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。store 句柄在区段之外（函数开头）取好，
 * 区段内只做同步的读写。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份存储，
 * 缓存下来的 Map 会变成孤儿，写入看不见、读到的还是旧数据。
 *
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT` + 唯一索引），
 * 上层的 service 与接口一行都不用改。
 */

// ——————————————————————————— 类型 ———————————————————————————

export type { AdminWriteContext };

/**
 * 这三组写操作共有的失败情形。
 *
 * 公共的三种（不存在 / 已移除 / 幂等键冲突）见 `AdminWriteCommonFailure`。
 * 这里只多一种：
 */
export type AdminContentWriteFailure =
  | AdminWriteCommonFailure
  /**
   * 快捷入口的目标地址没有通过安全校验。
   *
   * ⚠️ **服务层已经校验过一次**（`normalizeQuickEntryProfilePatch()`），这里是第二次。
   * 两次判断不是冗余：这一条守的是「用户端 `<Link>` 的 `href` 里不出现 `javascript:`
   * 或站外地址」这条**安全属性**，而它必须在**写入的那一刻**成立——
   * 服务层的校验发生在若干次 `await` 之前，中间隔着取会话、读请求体的时间。
   * 安全属性的守门函数可以重复，不可以缺失。
   */
  | { kind: "invalid-path" };

/**
 * 一次写操作的结果。
 *
 * 三种「成功」刻意分开：
 * - `changed: true` —— 真的改了数据，也写了审计；
 * - `changed: false, replayed: false` —— **提交的内容与现状一模一样**，不写数据、
 *   不写审计。这不是错误（管理员点了一次保存而没改任何东西），但接口要能告诉
 *   调用方「什么都没发生」，否则前端会显示一个「已保存」而实际没有写入；
 * - `changed: false, replayed: true` —— 同一个幂等键第二次到达。
 */
export type AdminContentWriteOutcome<T> =
  | {
      kind: "ok";
      value: {
        /** 新建时为 null（当时还不存在「更新前」） */
        previous: T | null;
        updated: T;
        action: AdminAuditAction;
      };
      changed: boolean;
      replayed: boolean;
    }
  | AdminContentWriteFailure;

/**
 * 三组内容各自的「记录类型 / 目标类型 / 编辑入参」三元组。
 *
 * ⚠️ 下面 12 个公开函数**不抽成一个泛型工厂**。抽了之后签名会变成
 * `writeContent<K extends ContentKind>(kind: K, ...)`，而「哪一组内容走哪一条路径」
 * 就从**函数名**退化成了一次**字符串参数**——一个拼错的 kind 在运行期才炸，
 * 而拼错的函数名编译期就炸。三组内容各自只有四个函数，写全比省下这几十行更值。
 */
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

/** id 前缀。与预置数据的短 id（`a1` / `b1` / `service`）从取值域上分开。 */
const ID_PREFIX: Record<ContentKind, string> = {
  announcement: "an_",
  banner: "bn_",
  quickEntry: "qe_",
};

/** `nextRecordId()` 的报错文案里用的类别名。 */
const KIND_LABEL: Record<ContentKind, string> = {
  announcement: "公告",
  banner: "活动图",
  quickEntry: "快捷入口",
};

// ——————————————————————————— 内部工具 ———————————————————————————

/** 从 store 里按类别取对应的 Map。 */
function mapOf<K extends ContentKind>(kind: K): Map<string, ContentRecordOf[K]> {
  const store = contentStore();
  if (kind === "announcement") return store.announcements as Map<string, ContentRecordOf[K]>;
  if (kind === "banner") return store.banners as Map<string, ContentRecordOf[K]>;
  return store.quickEntries as Map<string, ContentRecordOf[K]>;
}

/**
 * 把 draft 写进一条既有记录（覆盖式）。
 *
 * ⚠️ 与仓储里的 `applyProfile()` 分开而不是复用：仓储那一层是「存取」，
 * 它接收的是**已经确定要写什么**的 patch；这里要做的是把 draft 的字段
 * 逐项搬过去，并且**显式列出搬哪些字段**——将来给实体加一个服务端字段时，
 * 它不会因为「draft 里恰好同名字段」而被悄悄写进去。
 */
function applyDraft<K extends ContentKind>(
  kind: K,
  record: ContentRecordOf[K],
  draft: ContentDraftOf[K],
  at: string,
): ContentRecordOf[K] {
  const base = { ...(record as ContentAnnouncementRecord), ...(draft as object), updatedAt: at };
  // 归属与身份字段不可能来自 draft：这里显式写回来，作为最后一道保证
  const restored = { ...base, id: record.id, createdAt: record.createdAt, removedAt: record.removedAt };
  return restored as ContentRecordOf[K];
}

/** 审计快照的选择器。三组内容各有一个 builder，理由见各自函数上的注释。 */
function snapshotOf<K extends ContentKind>(kind: K, record: ContentRecordOf[K]): ReturnType<typeof toAnnouncementAuditSnapshot> {
  if (kind === "announcement") {
    return toAnnouncementAuditSnapshot(record as ContentAnnouncementRecord);
  }
  if (kind === "banner") return toBannerAuditSnapshot(record as ContentBannerRecord);
  return toQuickEntryAuditSnapshot(record as QuickEntryRecord);
}

/**
 * 这次编辑是否什么都没改。
 *
 * 三组内容各有自己的比较函数（`lib/constants/adminContent.ts`），因为字段不同。
 * 这里按类别分派，**不比较 JSON 字符串**：字符串比较会把字段顺序也算进差异，
 * 于是「同一个值的两种拼法」看起来像一次改动，凭空多出一条审计。
 */
function isUnchanged<K extends ContentKind>(
  kind: K,
  record: ContentRecordOf[K],
  draft: ContentDraftOf[K],
): boolean {
  if (kind === "quickEntry") {
    return isQuickEntryUnchanged(
      record as QuickEntryRecord,
      draft as AdminQuickEntryProfilePatch,
    );
  }
  return isContentImageUnchanged(
    record as ContentAnnouncementRecord | ContentBannerRecord,
    draft as AdminAnnouncementProfilePatch,
  );
}

/** 这次编辑对应哪一个审计动作：启用状态变了就是启停，否则是编辑。 */
function actionOf<K extends ContentKind>(
  kind: K,
  record: ContentRecordOf[K],
  draft: ContentDraftOf[K],
): AdminAuditAction {
  const changed = record.enabled !== draft.enabled;
  return `${kind}.${changed ? (draft.enabled ? "enable" : "disable") : "update"}` as AdminAuditAction;
}

// ——————————————————————————— 新建 ———————————————————————————

/**
 * 新建一条运营内容。
 *
 * 「同一个幂等键第二次到达」在这里必须靠**操作类型**识别，而不是靠目标 id：
 * 新建的目标 id 是在原子区段里当场生成的，第二次调用会生成一个不同的 id，
 * 按 id 比对只会把它误判成「幂等键被别的对象用了」。`takeCreateReplay()` 因此
 * 只认「这个键已经被同类型的对象用过」，再拿审计里记下的 id 把当时那条记录找回来。
 */
async function createContent<K extends ContentKind>(
  kind: K,
  draft: ContentDraftOf[K],
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  const map = mapOf(kind);
  const targetType = kind as AdminAuditTargetType;
  const action = `${kind}.create` as AdminAuditAction;

  // 快捷入口的路径在**原子区段之前**再判一次（见 `invalid-path` 的注释）。
  // 放在区段外不影响原子性：它是只读判断，不依赖区段内的任何状态。
  if (kind === "quickEntry" && !isSafePath((draft as AdminQuickEntryProfilePatch).path)) {
    return { kind: "invalid-path" };
  }

  // —— 原子区段开始（无 await）——
  const replay = takeCreateReplay(ctx, targetType);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  if (replay) {
    const existing = map.get(replay.targetId);
    // 审计里有、记录却没有：数据被清过。宁可报「不存在」，也不编一条出来
    if (!existing) return { kind: "not-found" };
    return {
      kind: "ok",
      value: { previous: null, updated: { ...existing }, action },
      changed: false,
      replayed: true,
    };
  }

  const created = {
    ...(draft as object),
    id: nextRecordId(ID_PREFIX[kind], (candidate) => map.has(candidate), KIND_LABEL[kind]),
    createdAt: ctx.at,
    updatedAt: ctx.at,
    removedAt: null,
  } as ContentRecordOf[K];

  map.set(created.id, { ...created });

  writeAudit({
    ctx,
    action,
    targetType,
    targetId: created.id,
    before: null,
    after: snapshotOf(kind, created),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous: null, updated: { ...created }, action },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 编辑 / 启停 / 移除 ———————————————————————————

async function updateContent<K extends ContentKind>(
  kind: K,
  id: string,
  draft: ContentDraftOf[K],
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  const map = mapOf(kind);
  const targetType = kind as AdminAuditTargetType;

  if (kind === "quickEntry" && !isSafePath((draft as AdminQuickEntryProfilePatch).path)) {
    return { kind: "invalid-path" };
  }

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, targetType, id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = map.get(id);
  if (!existing) return { kind: "not-found" };
  // 已移除的内容不再接受编辑：它已经不在用户端了，改名称与排序没有任何去向
  if (existing.removedAt !== null) return { kind: "removed" };

  const action = actionOf(kind, existing, draft);

  // 两种「什么都没发生」都不写数据、不写审计，且**都不是错误**
  if (replay?.kind === "replay" || isUnchanged(kind, existing, draft)) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const previous = { ...existing };
  const updated = applyDraft(kind, existing, draft, ctx.at);
  map.set(id, { ...updated });

  writeAudit({
    ctx,
    action,
    targetType,
    targetId: id,
    before: snapshotOf(kind, previous),
    after: snapshotOf(kind, updated),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous, updated: { ...updated }, action },
    changed: true,
    replayed: false,
  };
}

/**
 * 启用 / 停用（窄写入：只改这一个字段）。
 *
 * ⚠️ 与 `updateContent()` 分开，是因为它**不该碰名称、图片、排序**：
 * 列表页上的启用开关只应当改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的标题覆盖回旧值。
 */
async function setContentEnabled<K extends ContentKind>(
  kind: K,
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  const map = mapOf(kind);
  const targetType = kind as AdminAuditTargetType;
  const action = `${kind}.${enabled ? "enable" : "disable"}` as AdminAuditAction;

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, targetType, id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = map.get(id);
  if (!existing) return { kind: "not-found" };
  if (existing.removedAt !== null) return { kind: "removed" };

  if (replay?.kind === "replay" || existing.enabled === enabled) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const previous = { ...existing };
  // 只改这一个字段：不刷新其它字段，也不动 removedAt
  const updated = { ...existing, enabled, updatedAt: ctx.at } as ContentRecordOf[K];
  map.set(id, { ...updated });

  writeAudit({
    ctx,
    action,
    targetType,
    targetId: id,
    before: snapshotOf(kind, previous),
    after: snapshotOf(kind, updated),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous, updated: { ...updated }, action },
    changed: true,
    replayed: false,
  };
}

/**
 * 软移除。
 *
 * ⚠️ **不删记录**：与类目、商品同一个理由——已经发出去的内容事后要能回答
 * 「当时首页上那张图是什么」。真删了就只能靠猜。
 *
 * 幂等：已经移除的再移除一次，**不刷新时间戳**，返回 `changed: false`。
 */
async function removeContent<K extends ContentKind>(
  kind: K,
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentRecordOf[K]>> {
  const map = mapOf(kind);
  const targetType = kind as AdminAuditTargetType;
  const action = `${kind}.remove` as AdminAuditAction;

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, targetType, id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = map.get(id);
  if (!existing) return { kind: "not-found" };

  if (replay?.kind === "replay" || existing.removedAt !== null) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing }, action },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const previous = { ...existing };
  const updated = { ...existing, removedAt: ctx.at, updatedAt: ctx.at } as ContentRecordOf[K];
  map.set(id, { ...updated });

  writeAudit({
    ctx,
    action,
    targetType,
    targetId: id,
    before: snapshotOf(kind, previous),
    after: snapshotOf(kind, updated),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous, updated: { ...updated }, action },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 公开入口 ———————————————————————————

/** 新建图片公告。 */
export function createAnnouncement(
  draft: AdminAnnouncementProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return createContent("announcement", draft, ctx);
}

/** 编辑图片公告（标题 / 图片 / 说明 / 排序 / 启用状态一起提交）。 */
export function updateAnnouncement(
  id: string,
  draft: AdminAnnouncementProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return updateContent("announcement", id, draft, ctx);
}

/** 启用 / 停用图片公告。 */
export function setAnnouncementEnabled(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return setContentEnabled("announcement", id, enabled, ctx);
}

/** 软移除图片公告。 */
export function removeAnnouncement(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentAnnouncementRecord>> {
  return removeContent("announcement", id, ctx);
}

/** 新建活动 Banner。 */
export function createBanner(
  draft: AdminBannerProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return createContent("banner", draft, ctx);
}

/** 编辑活动 Banner。 */
export function updateBanner(
  id: string,
  draft: AdminBannerProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return updateContent("banner", id, draft, ctx);
}

/** 启用 / 停用活动 Banner。 */
export function setBannerEnabled(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return setContentEnabled("banner", id, enabled, ctx);
}

/** 软移除活动 Banner。 */
export function removeBanner(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<ContentBannerRecord>> {
  return removeContent("banner", id, ctx);
}

/** 新建快捷入口。目标地址在区段内会被再校验一次。 */
export function createQuickEntry(
  draft: AdminQuickEntryProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return createContent("quickEntry", draft, ctx);
}

/** 编辑快捷入口。目标地址在区段内会被再校验一次。 */
export function updateQuickEntry(
  id: string,
  draft: AdminQuickEntryProfilePatch,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return updateContent("quickEntry", id, draft, ctx);
}

/** 启用 / 停用快捷入口。 */
export function setQuickEntryEnabled(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return setContentEnabled("quickEntry", id, enabled, ctx);
}

/** 软移除快捷入口。 */
export function removeQuickEntry(
  id: string,
  ctx: AdminWriteContext,
): Promise<AdminContentWriteOutcome<QuickEntryRecord>> {
  return removeContent("quickEntry", id, ctx);
}
