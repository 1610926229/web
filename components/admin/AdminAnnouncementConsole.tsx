"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import AdminAnnouncementForm, {
  type ImageMaterialFormBodyProps,
} from "@/components/admin/AdminAnnouncementForm";
import AdminAnnouncementTable, {
  type ImageMaterialRow,
  type ImageMaterialTableBodyProps,
} from "@/components/admin/AdminAnnouncementTable";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  filterRowsByContentStatus,
  initialContentStatusFilter,
  removalForContentFilter,
  type ContentStatusFilter,
} from "@/components/admin/adminContentFilter";
import {
  normalizeAnnouncementProfilePatch,
  type ContentImageInput,
  type ContentRemovalFilter,
} from "@/lib/constants/adminContent";
import {
  createAdminAnnouncement,
  disableAnnouncement,
  enableAnnouncement,
  fetchAdminAnnouncements,
  removeAnnouncement,
  saveAnnouncementProfile,
  type AdminContentListRequest,
  type AdminContentWriteAck,
} from "@/lib/services/adminHttp";
import type { AdminAnnouncementProfilePatch, AdminContentList } from "@/lib/types/content";

/**
 * 图片公告的管理界面：**这一页唯一的写入口**。
 *
 * ⚠️ 公告与活动 Banner 的界面**只有一份实现**（本文件导出的 `ImageMaterialConsole`）。
 * 两者在数据形状上确实是同一种东西（见 `lib/constants/adminContent.ts`），
 * Banner 的默认导出（`AdminBannerConsole.tsx`）只是换一组服务函数与文案。
 *
 * 三条贯穿全页的做法：
 *
 * 1. **写成功后重新取一次列表**，并用服务端返回的那条记录作为表单的新基准。
 *    页面显示的是「服务端确认过的记录」，不是「刚才那次请求成功」这个事实
 *    拼出来的本地状态——两者会在两位管理员同时操作时分叉。
 *    同时调一次 `router.refresh()`：首屏那份数据是服务端组件渲染的，
 *    不刷新它，返回上一页或重新进入时会看到改动之前的列表。
 * 2. **不做分页**：这类运营内容是个位数到几十条。
 * 3. **窄写入**：列表上的「停用」只改 `enabled` 一个字段，不是把整条记录写回去；
 *    「移除」是独立的状态迁移，走自己的接口与二次确认。
 */

/** 一组图片素材的完整服务绑定。表单只用到 `slug` / `normalize` / `create` / `save`。 */
export type ImageMaterialConsoleBinding = {
  slug: string;
  normalize: (input: ContentImageInput) => AdminAnnouncementProfilePatch | null;
  /**
   * 取一页素材。
   *
   * ⚠️ 参数形状是**查询对象**（`{ removal }`）而不是裸的筛选值：这两个模块的列表
   * 除了「要不要看已移除的」之外，将来还可能有别的维度，而接口那一侧的
   * `resolveAdminContentListQuery()` 就是按对象解析的——多包一层不是为了好看，
   * 是为了让「客户端拼查询」与「服务端解查询」是同一个形状。
   */
  list: (input: AdminContentListRequest) => Promise<AdminContentList<ImageMaterialRow>>;
  create: (
    idempotencyKey: string,
    patch: AdminAnnouncementProfilePatch,
  ) => Promise<AdminContentWriteAck>;
  save: (
    id: string,
    idempotencyKey: string,
    patch: AdminAnnouncementProfilePatch,
  ) => Promise<AdminContentWriteAck>;
  enable: (id: string, idempotencyKey: string) => Promise<AdminContentWriteAck>;
  disable: (id: string, idempotencyKey: string) => Promise<AdminContentWriteAck>;
  remove: (id: string, idempotencyKey: string) => Promise<AdminContentWriteAck>;
};

export type ImageMaterialConsoleCopy = {
  newLabel: string;
  /** 启用不弹确认框，直接把结果说出来（与 `AdminStaffConsole` 同一条理由） */
  enableMessage: string;
  disableMessage: string;
  removeMessage: string;
  /** 记录本来就是目标状态（多半是另一位管理员刚改过）：**不是失败，也不是「已启用」** */
  unchangedActionMessage: string;
  /** 重试命中了第一次写入：服务端没有写第二次 */
  replayedActionMessage: string;
  disableConfirm: string;
  removeConfirm: string;
};

/** 需要二次确认的两个动作。启用不在其中——它是可逆的、不隐藏任何东西。 */
type ConfirmIntent = "disable" | "remove";
type FlagIntent = "enable" | ConfirmIntent;

const FLAG_LABELS: Record<FlagIntent, string> = {
  enable: "启用",
  disable: "停用",
  remove: "移除",
};

/**
 * 列表上那次操作的回执 → 提示语。
 *
 * ⚠️ 三种「没写进去」必须分开说，它们都不是失败，但也都**不是**「已启用」：
 *
 * - `replayed`：这个幂等键早就做过了，服务端没有第二次写入（失败重试命中了第一次）；
 * - `changed: false`：记录本来就是目标状态——多半是另一位管理员刚刚改过，
 *   所以列表刷新后看起来「确实是启用状态」，但**不是这次点的结果**；
 * - 其余才是这次真的改了。
 *
 * 把它们一律显示成「已启用」会让人对「我刚才到底改动了什么」产生一个错误印象，
 * 而两位管理员同时操作时，这个印象恰好是最需要准确的地方。
 */
function describeActionWrite(
  ack: AdminContentWriteAck,
  intent: FlagIntent,
  copy: ImageMaterialConsoleCopy,
): string {
  if (ack.replayed) return copy.replayedActionMessage;
  if (!ack.changed) return copy.unchangedActionMessage;
  if (intent === "enable") return copy.enableMessage;
  if (intent === "disable") return copy.disableMessage;
  return copy.removeMessage;
}

export type ImageMaterialConsoleProps = {
  binding: ImageMaterialConsoleBinding;
  copy: ImageMaterialConsoleCopy;
  /** 这一页的页头标题与说明（各模块不同：公告「不响应点击」、Banner「只展示一张」） */
  headingTitle: string;
  headingDescription: string;
  initialResult: AdminContentList<ImageMaterialRow>;
  initialRemoval: ContentRemovalFilter;
  /**
   * 列表与表单由各模块注入。
   *
   * ⚠️ 注入的是**组件**而不是一段 JSX：列表要拿到筛选、加载与错误状态，
   * 表单要拿到记录与回执——传一段已经渲染好的 JSX 会让这些状态出不去。
   */
  Table: (props: ImageMaterialTableBodyProps) => ReactNode;
  Form: (props: ImageMaterialFormBodyProps) => ReactNode;
};

export function ImageMaterialConsole({
  binding,
  copy,
  headingTitle,
  headingDescription,
  initialResult,
  initialRemoval,
  Table,
  Form,
}: ImageMaterialConsoleProps) {
  const router = useRouter();

  const [result, setResult] = useState(initialResult);
  /** 当前列表里装的是哪一批：`active`（未移除）还是 `removed`。换批次才需要重新取数 */
  const [loadedRemoval, setLoadedRemoval] = useState<ContentRemovalFilter>(initialRemoval);
  const [filter, setFilter] = useState<ContentStatusFilter>(
    initialContentStatusFilter(initialRemoval),
  );

  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [pending, setPending] = useState<{ intent: ConfirmIntent; row: ImageMaterialRow } | null>(
    null,
  );
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /** 表单的目标：`null` 表示收起，`{kind:"create"}` 是新建，`{kind:"edit"}` 带一条记录 */
  const [formTarget, setFormTarget] = useState<
    { kind: "create" } | { kind: "edit"; row: ImageMaterialRow } | null
  >(null);
  const [formMessage, setFormMessage] = useState("");

  /** 幂等键：**一次「动作意图」一个键**，失败重试沿用同一个，改做别的动作即换新 */
  const keyRef = useRef<string | null>(null);
  /** 先发后到的旧响应会被丢弃（快速连点两次筛选不会出现结果被覆盖） */
  const ticketRef = useRef(0);

  async function load(removal: ContentRemovalFilter): Promise<AdminContentList<ImageMaterialRow> | null> {
    const ticket = ++ticketRef.current;
    setLoading(true);
    setListError("");

    try {
      const next = await binding.list({ removal });
      if (ticket !== ticketRef.current) return null;

      setResult(next);
      setLoadedRemoval(removal);
      return next;
    } catch (cause) {
      if (ticket !== ticketRef.current) return null;
      setListError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
      return null;
    } finally {
      if (ticket === ticketRef.current) setLoading(false);
    }
  }

  /**
   * 写成功之后统一的收尾：重取列表 + 让服务端组件重跑一次。
   *
   * ⚠️ `router.refresh()` **不是多余的**：这一页的首屏数据由服务端组件渲染，
   * 只重取客户端那一份的话，地址栏直接打开 / 返回这一页时看到的还是旧列表。
   * 两者读的是同一个仓储，因此不会出现两份不一样的真相。
   */
  async function afterWrite() {
    await load(loadedRemoval);
    router.refresh();
  }

  async function runAction(intent: FlagIntent, row: ImageMaterialRow, key: string) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const ack =
        intent === "enable"
          ? await binding.enable(row.id, key)
          : intent === "disable"
            ? await binding.disable(row.id, key)
            : await binding.remove(row.id, key);

      keyRef.current = null;
      setPending(null);
      await afterWrite();
      setFlash(describeActionWrite(ack, intent, copy));
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  /** 启用不需要确认：领好幂等键直接提交。 */
  function runEnable(row: ImageMaterialRow) {
    if (busy) return;
    keyRef.current = crypto.randomUUID();
    void runAction("enable", row, keyRef.current);
  }

  function openIntent(intent: ConfirmIntent, row: ImageMaterialRow) {
    keyRef.current = crypto.randomUUID();
    setConfirmError(null);
    setFlash("");
    setPending({ intent, row });
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPending(null);
    setConfirmError(null);
  }

  function changeFilter(next: ContentStatusFilter) {
    setFilter(next);
    setFlash("");
    const needed = removalForContentFilter(next);
    // 「全部 / 已启用 / 已停用」在同一批数据里分，只有换到「已移除」才需要重新取数
    if (needed !== loadedRemoval) void load(needed);
  }

  function openCreate() {
    setFlash("");
    setFormMessage("");
    setFormTarget({ kind: "create" });
  }

  function openEdit(row: ImageMaterialRow) {
    setFlash("");
    setFormMessage("");
    setFormTarget({ kind: "edit", row });
  }

  function closeForm() {
    setFormTarget(null);
    setFormMessage("");
  }

  async function handleSaved(message: string) {
    const created = formTarget?.kind === "create";
    setFormMessage(message);
    setFlash("");

    if (created) {
      // 新建成功后收起表单并切到「全部」：否则当前筛选若是「已停用」，
      // 刚建好的那条不会出现在列表里，人会以为没保存成功
      setFormTarget(null);
      setFilter("all");
      await load("active");
      router.refresh();
      setFlash(message);
      setFormMessage("");
      return;
    }

    const next = await load(loadedRemoval);
    router.refresh();

    // 让表单以**服务端最新的那条记录**为基准重挂载（`key` 含 `updatedAt`）。
    // 不重新指向的话，表单里还留着提交前的旧值，第二次保存会把第一次的改动写回去
    const target = formTarget;
    const fresh =
      target?.kind === "edit" ? next?.items.find((row) => row.id === target.row.id) : undefined;
    if (fresh) setFormTarget({ kind: "edit", row: fresh });

    setFlash(message);
    setFormMessage("");
  }

  const rows = filterRowsByContentStatus(result.items, filter);
  const formKey =
    formTarget?.kind === "edit" ? `${formTarget.row.id}:${formTarget.row.updatedAt}` : "create";

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title={headingTitle} description={headingDescription}>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-white"
        >
          {copy.newLabel}
        </button>
      </AdminPageHeading>

      {formTarget ? (
        <Form
          key={formKey}
          record={formTarget.kind === "edit" ? formTarget.row : null}
          binding={binding}
          message={formMessage}
          onSaved={(message) => void handleSaved(message)}
          onCancel={closeForm}
        />
      ) : null}

      {flash ? (
        <p role="status" className="text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      <Table
        rows={rows}
        counts={result.counts}
        filter={filter}
        loading={loading}
        error={listError}
        busy={busy}
        emptyMessage="这个筛选下还没有素材。点右上角新建一张，用户端下一次刷新就会出现。"
        removedEmptyMessage="还没有被移除的素材。移除是软删除，被移除的记录会留在这里供回查。"
        onFilterChange={changeFilter}
        onRetry={() => void load(loadedRemoval)}
        onEdit={openEdit}
        onToggleEnabled={(row) => (row.enabled ? openIntent("disable", row) : runEnable(row))}
        onRemove={(row) => openIntent("remove", row)}
      />

      <AdminConfirmDialog
        open={pending !== null}
        title={pending ? `${FLAG_LABELS[pending.intent]}这张素材` : ""}
        description={pending?.intent === "remove" ? copy.removeConfirm : copy.disableConfirm}
        confirmLabel={pending ? `确认${FLAG_LABELS[pending.intent]}` : ""}
        tone="danger"
        pending={busy}
        error={confirmError}
        onConfirm={() => {
          const key = keyRef.current;
          if (key && pending) void runAction(pending.intent, pending.row, key);
        }}
        onCancel={closeIntent}
      />
    </div>
  );
}

/**
 * 公告的服务绑定。
 *
 * ⚠️ `normalize` 必须是 `normalizeAnnouncementProfilePatch()`：表单**只**把
 * 校验过、去过空白的 patch 发出去，因此不存在「前端漏掉一条规则、把脏数据写进去」
 * 的路径。三张列表各自读的是同一个仓储，所以这里改完，用户端刷新就是新的。
 */
const ANNOUNCEMENT_BINDING: ImageMaterialConsoleBinding = {
  slug: "announcement",
  normalize: normalizeAnnouncementProfilePatch,
  list: fetchAdminAnnouncements,
  create: createAdminAnnouncement,
  save: saveAnnouncementProfile,
  enable: enableAnnouncement,
  disable: disableAnnouncement,
  remove: removeAnnouncement,
};

const ANNOUNCEMENT_CONSOLE_COPY: ImageMaterialConsoleCopy = {
  newLabel: "新增公告",
  enableMessage: "已启用：用户端下一次刷新就会轮播到它",
  disableMessage: "已停用：用户端下一次刷新起不再轮播它；记录与图片都保留",
  removeMessage: "已移除：用户端立即不可见，记录保留可回查",
  unchangedActionMessage:
    "这条素材已经是目标状态，这次没有写入任何改动（可能是另一位管理员刚改过）；列表已按服务端最新的记录刷新",
  replayedActionMessage:
    "这次操作与刚才那次是同一个请求，服务端没有重复写入；列表显示的就是刚才那次的结果",
  disableConfirm:
    "停用后用户端立即看不到这张公告图，轮播里少一张；记录与图片都保留，随时可以重新启用。",
  removeConfirm:
    "移除后用户端立即不可见，记录保留可回查。移除是**不可撤销**的——之后不能再编辑或重新启用这条记录，需要用到这张图时请新建一条。",
};

/** 公告管理界面：把公告的服务函数与文案绑到共用实现上。 */
export default function AdminAnnouncementConsole({
  initialResult,
  initialRemoval,
}: {
  initialResult: AdminContentList<ImageMaterialRow>;
  initialRemoval: ContentRemovalFilter;
}) {
  return (
    <ImageMaterialConsole
      binding={ANNOUNCEMENT_BINDING}
      copy={ANNOUNCEMENT_CONSOLE_COPY}
      headingTitle="图片公告"
      headingDescription={
        "用户在首页顶部看到的是一张张自动轮播的公告图。" +
        "公告**只做图片滚动展示、不响应点击**，因此这里没有「目标地址」可填——" +
        "能调的只有图片、顺序与启用状态；改完用户端刷新即可见，两处读的是同一份数据。"
      }
      initialResult={initialResult}
      initialRemoval={initialRemoval}
      Table={AdminAnnouncementTable}
      Form={AdminAnnouncementForm}
    />
  );
}
