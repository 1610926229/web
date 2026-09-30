"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AdminAgreementForm from "@/components/admin/AdminAgreementForm";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminStatusBadge, { CONTENT_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import { adminContentStatus } from "@/lib/constants/adminContent";
import { AGREEMENT_TYPES, agreementTypeLabel, formatAgreementVersion } from "@/lib/constants/agreements";
import {
  disableAgreement,
  enableAgreement,
  fetchAdminAgreementDetail,
  fetchAdminAgreements,
} from "@/lib/services/adminHttp";
import type {
  AdminAgreementDetail,
  AdminAgreementListData,
  AdminAgreementListItem,
  AgreementType,
} from "@/lib/types/agreement";

/**
 * 协议与版本介绍的管理界面。
 *
 * 与三组运营内容（公告 / 活动图 / 快捷入口）不同的地方，一是**没有新建也没有移除**：
 * 五类内容是固定的（`AGREEMENT_TYPES`），要下架用「停用」——那是可逆的，
 * 而「移除」需要造一个「用户端的协议少了一类」的状态，那不是任何人的意图。
 * 二是**正文不随列表返回**：`sections` 是几十段法律文本，列表一次要带五条，
 * 因此列表行只有 `sectionCount` / `paragraphCount` 两个标量，正文按需单独取一份详情。
 *
 * 三条贯穿全页的做法：
 *
 * 1. **写成功后重新取列表，并重新取一次详情**：列表要跟着更新（状态、版本号、
 *    正文规模都会变），而表单也必须以**服务端确认过的正文**为基准重挂载——
 *    留在本地那份上再点一次保存，会把服务端刚递增过的版本号又当成一次改动。
 * 2. **列表顺序就是页签顺序**（`AGREEMENT_TYPES`），由服务端排好；这里是同一个顺序的
 *    类型筛选，运营看到的次序与用户在用户端看到的页签次序完全一致。
 * 3. **窄写入**：列表上的「停用」走独立的 `/disable` 接口，只改 `enabled`，
 *    不会顺带把正文覆盖成按钮渲染时的旧值。
 */

/** 列表的筛选：`all` 之外就是 `AGREEMENT_TYPES` 里的某一个类型。 */
type AgreementTypeFilter = AgreementType | "all";

export default function AdminAgreementConsole({
  initialData,
}: {
  initialData: AdminAgreementListData;
}) {
  const router = useRouter();

  const [data, setData] = useState(initialData);
  const [typeFilter, setTypeFilter] = useState<AgreementTypeFilter>("all");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");

  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [pendingDisable, setPendingDisable] = useState<AdminAgreementListItem | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  /** 正在编辑哪一条；`null` 表示表单收起。正文另存在 `detail` 里（要单独取） */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminAgreementDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [formMessage, setFormMessage] = useState("");

  /** 幂等键：**一次「动作意图」一个键**，失败重试沿用同一个，改做别的动作即换新 */
  const keyRef = useRef<string | null>(null);
  /** 先发后到的旧响应会被丢弃（快速连点两次筛选不会出现结果被覆盖） */
  const ticketRef = useRef(0);

  async function load(): Promise<AdminAgreementListData | null> {
    const ticket = ++ticketRef.current;
    setLoading(true);
    setListError("");

    try {
      const next = await fetchAdminAgreements();
      if (ticket !== ticketRef.current) return null;

      setData(next);
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
   * 取一份协议的正文。
   *
   * ⚠️ 必须单独取一次：列表行里**没有** `sections`（`AdminAgreementListItem` 刻意不带），
   * 拿列表去拼编辑表单只能拼出一个空正文，一保存就把用户看到的协议清空了。
   */
  async function loadDetail(id: string): Promise<AdminAgreementDetail | null> {
    setDetailLoading(true);
    setDetailError("");

    try {
      const next = await fetchAdminAgreementDetail(id);
      setDetail(next);
      return next;
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : "读不到正文，请稍后重试。");
      return null;
    } finally {
      setDetailLoading(false);
    }
  }

  async function runToggle(row: AdminAgreementListItem, enabled: boolean, key: string) {
    setBusy(true);
    setConfirmError(null);
    setFlash("");

    try {
      const ack = enabled ? await enableAgreement(row.id, key) : await disableAgreement(row.id, key);

      keyRef.current = null;
      setPendingDisable(null);
      await load();
      // 服务端组件渲染的那一份首屏数据也要跟着变：不刷新它，返回这一页时看到的还是旧状态
      router.refresh();

      // ⚠️ 协议的写结果**没有** `replayed` 字段（见 `AdminAgreementWriteResult`），
      // 因此这里只有「写了」与「什么都没写」两种说法要分开——
      // 后者多半意味着另一位管理员刚刚改过，列表刷新后看起来是对的，
      // 但那不是这次点击的结果，不能显示成「已启用」
      if (!ack.changed) {
        setFlash(
          "这份协议已经是目标状态，这次没有写入任何改动（可能是另一位管理员刚改过）；列表已按服务端最新的记录刷新",
        );
      } else if (enabled) {
        setFlash("已启用：用户端「相关协议」页下一次刷新就会显示这一份");
      } else {
        setFlash(
          "已停用：用户端会显示同类型里版本号最高的那份**启用**内容；一份启用的都没有时显示「内容暂未配置」，重新启用即可恢复",
        );
      }
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  /** 启用不需要确认：领好幂等键直接提交。可逆的动作不该用对话框拖慢它。 */
  function runEnable(row: AdminAgreementListItem) {
    if (busy) return;
    keyRef.current = crypto.randomUUID();
    void runToggle(row, true, keyRef.current);
  }

  function openDisable(row: AdminAgreementListItem) {
    keyRef.current = crypto.randomUUID();
    setConfirmError(null);
    setFlash("");
    setPendingDisable(row);
  }

  function closeDisable() {
    if (busy) return;
    keyRef.current = null;
    setPendingDisable(null);
    setConfirmError(null);
  }

  function openEdit(row: AdminAgreementListItem) {
    setFlash("");
    setFormMessage("");
    setDetail(null);
    setEditingId(row.id);
    void loadDetail(row.id);
  }

  function closeForm() {
    setEditingId(null);
    setDetail(null);
    setFormMessage("");
    setDetailError("");
  }

  /**
   * 表单保存之后。
   *
   * ⚠️ 重取详情这一步不是多余的：正文与版本号都是服务端算出来的，本地那份是**提交前**的。
   * 不重取的话，表单会以一个自己没提交过的版本继续开着，第二次点保存会把第一次的改动
   * 当成「又改了一次」——版本号会被推高一格，而内容一个字都没变。
   */
  async function handleSaved(message: string) {
    const id = editingId;
    setFormMessage(message);
    setFlash("");

    await load();
    router.refresh();

    if (id !== null) await loadDetail(id);

    setFlash(message);
    setFormMessage("");
  }

  const rows =
    typeFilter === "all" ? data.items : data.items.filter((row) => row.type === typeFilter);

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title="协议与版本介绍" description={data.notice} />

      {/* 类型筛选：顺序即 `AGREEMENT_TYPES`，与用户端「相关协议」的页签顺序完全一致。
          它是**在已取回的那一批里分**，不重新请求——协议一共就五类、一次全部返回 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={typeFilter === "all"}
          onClick={() => setTypeFilter("all")}
          className={`rounded-lg border px-3 py-1.5 text-[13px] ${
            typeFilter === "all"
              ? "border-admin-accent bg-brand-blue-soft text-ink"
              : "border-admin-line text-ink-2 hover:bg-page"
          }`}
        >
          全部
          <span className="ml-1 tabular-nums text-ink-3">（{data.items.length}）</span>
        </button>

        {AGREEMENT_TYPES.map((type) => {
          const active = typeFilter === type;
          const count = data.items.filter((row) => row.type === type).length;

          return (
            <button
              key={type}
              type="button"
              aria-pressed={active}
              onClick={() => setTypeFilter(type)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] ${
                active
                  ? "border-admin-accent bg-brand-blue-soft text-ink"
                  : "border-admin-line text-ink-2 hover:bg-page"
              }`}
            >
              {agreementTypeLabel(type)}
              <span className="ml-1 tabular-nums text-ink-3">（{count}）</span>
            </button>
          );
        })}

        {loading ? (
          <span role="status" aria-live="polite" className="text-[12px] text-ink-3">
            加载中…
          </span>
        ) : null}
      </div>

      {listError ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-admin-line bg-surface p-4">
          <p role="alert" className="text-[13px] leading-5 text-brand-red">
            {listError}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
          >
            重试
          </button>
        </div>
      ) : null}

      {!listError && rows.length === 0 ? (
        <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
          <p className="text-[13px] text-ink-2">
            {data.items.length === 0
              ? "一份协议都没有读到。这里没有新建入口——五类内容是固定的，缺的内容应当是数据没有初始化。"
              : "这个类型下没有记录。切回「全部」看看其它类型。"}
          </p>
        </div>
      ) : null}

      {/* 表单开在列表上方：编辑正文时要能一边改一边看到版本号与正文规模 */}
      {editingId !== null ? (
        <div className="flex flex-col gap-3">
          {detailLoading && detail === null ? (
            <p role="status" aria-live="polite" className="text-[13px] text-ink-3">
              正在读取正文…
            </p>
          ) : null}

          {detailError ? (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-admin-line bg-surface p-4">
              <p role="alert" className="text-[13px] leading-5 text-brand-red">
                {detailError}
              </p>
              <span className="flex gap-3">
                <button
                  type="button"
                  onClick={() => void loadDetail(editingId)}
                  className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
                >
                  重试
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
                >
                  收起表单
                </button>
              </span>
            </div>
          ) : null}

          {detail ? (
            <AdminAgreementForm
              // `key` 含版本号与更新时间：服务端换了正文就重挂载，
              // 表单里绝不会留着上一版的段落（理由见 `handleSaved()`）
              key={`${detail.id}:${detail.version}:${detail.updatedAt}`}
              record={detail}
              message={formMessage}
              onSaved={(message) => void handleSaved(message)}
              onCancel={closeForm}
            />
          ) : null}
        </div>
      ) : null}

      {flash ? (
        <p role="status" className="text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      {!listError && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-admin-line bg-surface">
          <table className="w-full min-w-[960px] border-collapse text-[13px]">
            <caption className="sr-only">
              协议列表，当前筛选下 {rows.length} 条。顺序与用户端「相关协议」的页签顺序一致。
            </caption>
            <thead>
              <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                <th scope="col" className="px-4 py-3 font-medium">
                  类型
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  标题
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  版本
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  状态
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  正文规模
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  更新时间
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // 协议没有软删除：五类内容是固定的，「下架」用停用（可逆）表达。
                // 因此这里的状态只有「已启用 / 已停用」两种，`removedAt` 恒为 null
                const status = adminContentStatus({ enabled: row.enabled, removedAt: null });

                return (
                  <tr key={row.id} className="border-b border-admin-line last:border-b-0">
                    <td className="px-4 py-3 text-ink-2">{row.typeLabel}</td>
                    <td className="px-4 py-3">
                      <span className="block text-ink">{row.title}</span>
                      <span className="block font-mono text-[12px] text-ink-3">{row.id}</span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-2">
                      {formatAgreementVersion(row.version)}
                    </td>
                    <td className="px-4 py-3">
                      {/* 状态不只有颜色：label 与 description 都是必填的（§十一） */}
                      <AdminStatusBadge
                        label={status.label}
                        description={status.description}
                        tone={CONTENT_STATUS_TONE[status.key]}
                      />
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-2">
                      {row.sectionCount} 节 / {row.paragraphCount} 段
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-3">{row.updatedAt}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => openEdit(row)}
                          className="text-[13px] text-admin-accent underline-offset-2 hover:underline disabled:opacity-40"
                        >
                          编辑正文
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => (row.enabled ? openDisable(row) : runEnable(row))}
                          className="text-[13px] text-ink-2 underline-offset-2 hover:underline disabled:opacity-40"
                        >
                          {row.enabled ? "停用" : "启用"}
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-[12px] leading-4 text-ink-3">
        这里只能改标题、正文与启用状态。类型是记录的身份证（改类型等于换了一份协议），
        版本号与更新时间由服务端在写入时算出来——客户端传什么都没用。
      </p>

      <AdminConfirmDialog
        open={pendingDisable !== null}
        title={pendingDisable ? `停用《${pendingDisable.title}》` : ""}
        description={
          "停用后用户端「相关协议」页不再显示这一份，会改为显示同类型里版本号最高的那份**启用**内容；" +
          "该类型一份启用的都没有时，用户端看到的是「内容暂未配置」。正文与版本号都保留，重新启用即可恢复。"
        }
        confirmLabel="确认停用"
        tone="danger"
        pending={busy}
        error={confirmError}
        onConfirm={() => {
          const key = keyRef.current;
          if (key && pendingDisable) void runToggle(pendingDisable, false, key);
        }}
        onCancel={closeDisable}
      />
    </div>
  );
}
