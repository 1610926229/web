"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminQuickEntryForm from "@/components/admin/AdminQuickEntryForm";
import AdminQuickEntryTable, {
  type QuickEntryRow,
} from "@/components/admin/AdminQuickEntryTable";
import {
  filterRowsByContentStatus,
  initialContentStatusFilter,
  removalForContentFilter,
  type ContentStatusFilter,
} from "@/components/admin/adminContentFilter";
import type { ContentRemovalFilter } from "@/lib/constants/adminContent";
import {
  createAdminQuickEntry,
  disableQuickEntry,
  enableQuickEntry,
  fetchAdminQuickEntries,
  removeQuickEntry,
  saveQuickEntryProfile,
  type AdminContentWriteAck,
} from "@/lib/services/adminHttp";
import type { AdminContentList } from "@/lib/types/content";

/**
 * 快捷入口的管理界面：**这一页唯一的写入口**。
 *
 * ⚠️ 它**没有**和图片公告 / 活动 Banner 共用一份控制台，尽管三者的状态机几乎一样。
 * 差别不在状态机，而在**要提交的东西**：那里是「一张图 + 图注」，
 * 这里是「名称 + 图标 + 目标地址」。硬合成一个组件的结果是两边都得长出
 * 「如果是公告就…否则…」的分支，而分支两侧只有一侧会被改到。
 * 共用的是筛选口径（`adminContentFilter.ts`）与确认框、表单字段容器这些零件。
 *
 * 三条贯穿全页的做法（与公告页相同，理由也相同）：
 *
 * 1. **写成功后重新取一次列表**并 `router.refresh()`：页面显示的是服务端确认过的记录，
 *    不是「这次请求成功了」拼出来的本地状态——两者会在两位管理员同时操作时分叉。
 * 2. **不做分页**：这类运营内容是个位数到几十条。
 * 3. **窄写入**：列表上的「停用」只走 `/disable` 改 `enabled` 一个字段，
 *    不是把整条记录写回去；「移除」是独立的状态迁移，有自己的接口与二次确认。
 */

/** 需要二次确认的两个动作。启用不在其中——它是可逆的，也不隐藏任何东西。 */
type ConfirmIntent = "disable" | "remove";
type FlagIntent = "enable" | ConfirmIntent;

const FLAG_LABELS: Record<FlagIntent, string> = {
  enable: "启用",
  disable: "停用",
  remove: "移除",
};

const FLAG_MESSAGES: Record<FlagIntent, string> = {
  enable: "已启用：用户端首页下一次刷新就能看到这个入口",
  disable: "已停用：用户端首页四宫格里不再有它；记录与配置都保留，随时可以重新启用",
  remove: "已移除：用户端立即不可见，记录保留可回查",
};

/**
 * 列表上那次操作的回执 → 提示语。
 *
 * ⚠️ 重试命中（`replayed`）与「记录本来就是目标状态」（`changed: false`）
 * 都**没有**写入，也都不该显示成「已启用」——后者多半意味着另一位管理员刚改过，
 * 列表刷新后看起来是对的，但那不是这次点击的结果（与公告页同一套判断）。
 */
function describeActionWrite(ack: AdminContentWriteAck, intent: FlagIntent): string {
  if (ack.replayed) {
    return "这次操作与刚才那次是同一个请求，服务端没有重复写入；列表显示的就是刚才那次的结果";
  }
  if (!ack.changed) {
    return "这个入口已经是目标状态，这次没有写入任何改动（可能是另一位管理员刚改过）；列表已按服务端最新的记录刷新";
  }
  return FLAG_MESSAGES[intent];
}

export default function AdminQuickEntryConsole({
  initialResult,
  initialRemoval,
}: {
  initialResult: AdminContentList<QuickEntryRow>;
  initialRemoval: ContentRemovalFilter;
}) {
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
  const [pending, setPending] = useState<{ intent: ConfirmIntent; row: QuickEntryRow } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /** 表单的目标：`null` 表示收起，`{kind:"create"}` 是新建，`{kind:"edit"}` 带一条记录 */
  const [formTarget, setFormTarget] = useState<
    { kind: "create" } | { kind: "edit"; row: QuickEntryRow } | null
  >(null);
  const [formMessage, setFormMessage] = useState("");

  /** 幂等键：**一次「动作意图」一个键**，失败重试沿用同一个，改做别的动作即换新 */
  const keyRef = useRef<string | null>(null);
  /** 先发后到的旧响应会被丢弃（快速连点两次筛选不会出现结果被覆盖） */
  const ticketRef = useRef(0);

  async function load(
    removal: ContentRemovalFilter,
  ): Promise<AdminContentList<QuickEntryRow> | null> {
    const ticket = ++ticketRef.current;
    setLoading(true);
    setListError("");

    try {
      const next = await fetchAdminQuickEntries({ removal });
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

  async function runAction(intent: FlagIntent, row: QuickEntryRow, key: string) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const ack =
        intent === "enable"
          ? await enableQuickEntry(row.id, key)
          : intent === "disable"
            ? await disableQuickEntry(row.id, key)
            : await removeQuickEntry(row.id, key);

      keyRef.current = null;
      setPending(null);
      await afterWrite();
      setFlash(describeActionWrite(ack, intent));
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  /** 启用不需要确认：领好幂等键直接提交。 */
  function runEnable(row: QuickEntryRow) {
    if (busy) return;
    keyRef.current = crypto.randomUUID();
    void runAction("enable", row, keyRef.current);
  }

  function openIntent(intent: ConfirmIntent, row: QuickEntryRow) {
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

  function openEdit(row: QuickEntryRow) {
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

    // 让表单以**服务端最新的那条记录**为基准重挂载（`key` 里含 `updatedAt`）。
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
      <AdminPageHeading
        title="快捷入口"
        description={
          "用户端首页是**四宫格**（最多四个位置最合适）：排序值决定谁占前四位。" +
          "目标地址必须是站内路径——它会被直接放进用户端的链接里，站外地址一律被拒绝。" +
          "改完用户端刷新即可见，两处读的是同一份数据。"
        }
      >
        <button
          type="button"
          onClick={openCreate}
          className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-white"
        >
          新增入口
        </button>
      </AdminPageHeading>

      {formTarget ? (
        <AdminQuickEntryForm
          key={formKey}
          record={formTarget.kind === "edit" ? formTarget.row : null}
          create={createAdminQuickEntry}
          save={saveQuickEntryProfile}
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

      <AdminQuickEntryTable
        rows={rows}
        counts={result.counts}
        filter={filter}
        loading={loading}
        error={listError}
        busy={busy}
        footerNote={
          "用户端是四宫格：超过四条时后面的会折到第二行，布局就不再是设计稿里的样子。" +
          "排序值越小越靠前（越靠左）；停用或移除后，用户端下一次刷新就不再显示它。"
        }
        onFilterChange={changeFilter}
        onRetry={() => void load(loadedRemoval)}
        onEdit={openEdit}
        onToggleEnabled={(row) => (row.enabled ? openIntent("disable", row) : runEnable(row))}
        onRemove={(row) => openIntent("remove", row)}
      />

      <AdminConfirmDialog
        open={pending !== null}
        title={pending ? `${FLAG_LABELS[pending.intent]}这个快捷入口` : ""}
        description={
          pending?.intent === "remove"
            ? "移除后用户端立即不可见，记录保留可回查。移除是**不可撤销**的——之后不能再编辑或重新启用这条记录，需要用到它时请新建一条。"
            : "停用后用户端立即看不到它，四宫格里会空出一个位置；记录与配置都保留，随时可以重新启用。"
        }
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
