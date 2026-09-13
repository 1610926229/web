"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminCategoryForm from "@/components/admin/AdminCategoryForm";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminStatItem from "@/components/admin/AdminStatItem";
import AdminStatusBadge, { CATEGORY_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_CATEGORY_ACTION_LABELS,
  ADMIN_CATEGORY_CONFIRM_TEXTS,
  ADMIN_CATEGORY_REMOVED_MESSAGE,
  adminCategoryHasProductsMessage,
  adminCategoryStatus,
  type CategoryGameOption,
} from "@/lib/constants/adminCategories";
import {
  disableCategory,
  enableCategory,
  fetchAdminCategory,
  removeCategory,
} from "@/lib/services/adminHttp";
import type { AdminCategoryListItem, AdminCategoryWriteResult } from "@/lib/types/catalog";

/** 需要二次确认的状态动作。 */
type FlagIntent = "enable" | "disable" | "remove";

const FLAG_SUCCESS_MESSAGE: Record<FlagIntent, string> = {
  enable: "已启用：该类目重新出现在用户端分类导航里，并可再次用于商品归属",
  disable: "已停用：用户端导航里不再有它，也不能再用于商品归属；它下面的商品不受影响",
  remove: "已移除：用户端不再可见，商品归属与历史记录均已保留",
};

/**
 * 类目详情的**唯一写入口**：状态动作 + 编辑表单。
 *
 * 为什么两件事放在一个组件里：它们写的是同一条记录，而且都要在写成功后
 * 拿到**服务端的最新值**。分成两个组件各自刷新，就会出现「按钮已经把类目停用了，
 * 编辑表单里还写着启用」——表单提交时会把状态又改回去。
 * 这里统一成一条刷新路径：**任何一次写成功都重新取一次详情**，
 * 表单用 `key` 重挂载，因此永远以服务端为准，而不是以「刚才那次请求的返回值」为准。
 *
 * ⚠️ 快捷动作走**窄写入**接口（只改一个字段），不是把整条记录写回去：
 * 「停用」不该顺带把名称、排序覆盖成按钮渲染时的旧值。
 * 编辑表单则是**整份资料的覆盖写**，两种语义对应两个接口，互不冒充。
 *
 * ⚠️ 所有危险动作都要二次确认，但确认框**不是防重手段**：
 * 真正的防重是每次提交带上的幂等键 + 服务端的状态判断（§九）。
 */
export default function AdminCategoryConsole({
  record: initialRecord,
  games,
}: {
  record: AdminCategoryListItem;
  games: CategoryGameOption[];
}) {
  const [record, setRecord] = useState(initialRecord);
  /** 每次写成功后自增：编辑表单以它为 key 重挂载，从而以服务端最新值重新填表 */
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 状态动作的结果（显示在状态卡片里） */
  const [actionFlash, setActionFlash] = useState("");
  /** 编辑表单的保存结果（作为 prop 传给表单，它重挂载后仍然拿得到） */
  const [formFlash, setFormFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<FlagIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);

  const status = adminCategoryStatus(record);
  const removed = record.removedAt !== null;
  const blockedByProducts = record.productCount > 0;

  async function runWrite(intent: FlagIntent, key: string) {
    setBusy(true);
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");

    try {
      const result: AdminCategoryWriteResult = await {
        enable: () => enableCategory(record.id, key),
        disable: () => disableCategory(record.id, key),
        remove: () => removeCategory(record.id, key),
      }[intent]();

      keyRef.current = null;
      setPendingIntent(null);

      // 无论服务端说「改了」还是「已经是这个状态」，都重新取一次详情：
      // 前端不拿响应里的几个字段自己拼出新状态，那会和真实记录分叉
      const fresh = await fetchAdminCategory(record.id);
      setRecord(fresh);
      setVersion((value) => value + 1);
      setActionFlash(
        result.changed ? FLAG_SUCCESS_MESSAGE[intent] : "该类目已处于这个状态，未产生新的变更",
      );
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: FlagIntent) {
    keyRef.current = crypto.randomUUID();
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");
    setPendingIntent(intent);
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPendingIntent(null);
    setConfirmError(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[16px] font-medium text-ink">{record.name}</p>
            <p className="font-mono text-[12px] text-ink-3">{record.id}</p>
          </div>

          <div className="flex flex-col gap-1">
            <AdminStatusBadge
              label={status.label}
              description={status.description}
              tone={CATEGORY_STATUS_TONE[status.key]}
            />
            {record.removedAt ? (
              <span className="text-[12px] text-ink-3">移除时间：{record.removedAt}</span>
            ) : null}
          </div>
        </div>

        {/* 状态动作 */}
        <h2 className="mt-5 text-[15px] font-medium text-ink">状态操作</h2>
        {removed ? (
          <p className="mt-2 text-[13px] leading-5 text-ink-3">{ADMIN_CATEGORY_REMOVED_MESSAGE}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openIntent("disable")}
              disabled={!record.enabled}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {ADMIN_CATEGORY_ACTION_LABELS.disable}
            </button>
            <button
              type="button"
              onClick={() => openIntent("enable")}
              disabled={record.enabled}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
            >
              {ADMIN_CATEGORY_ACTION_LABELS.enable}
            </button>
            <button
              type="button"
              onClick={() => openIntent("remove")}
              disabled={blockedByProducts}
              aria-describedby={blockedByProducts ? "category-remove-blocked" : undefined}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {ADMIN_CATEGORY_ACTION_LABELS.remove}
            </button>
          </div>
        )}

        {/* 不能移除时把**原因**说清楚，而不是只给一个灰按钮：
            灰按钮不解释自己，人会反复点它 */}
        {!removed && blockedByProducts ? (
          <p id="category-remove-blocked" className="mt-2 text-[12px] leading-4 text-ink-3">
            {adminCategoryHasProductsMessage(record.productCount)}
            「移除」因此暂时不可用——这个数字来自服务端，真正的拒绝也在服务端。
          </p>
        ) : null}

        <p className="mt-3 text-[12px] leading-4 text-ink-3">
          停用 = 用户端导航里没有它，也不能再用于商品归属，但它下面的商品仍然在架（直链可用）；
          移除 = 软删除，记录保留、商品归属仍可追溯，历史订单不受影响。
        </p>

        {actionFlash ? (
          <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
            {actionFlash}
          </p>
        ) : null}
      </section>

      {/* 只读区块：这些字段由系统维护，页面只能看 */}
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <h2 className="text-[15px] font-medium text-ink">归属与时间（只读）</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <AdminStatItem label="所属游戏" value={record.gameName} />
          <AdminStatItem label="展示排序" value={String(record.sortOrder)} />
          <AdminStatItem
            label="该类目商品"
            value={String(record.productCount)}
            hint="只数未移除的商品"
          />
          <AdminStatItem label="创建时间" value={record.createdAt} />
        </dl>

        <div className="mt-4 flex flex-col gap-1 text-[13px]">
          <div className="flex gap-3">
            <span className="w-24 shrink-0 text-ink-3">最近更新</span>
            <span className="min-w-0 flex-1 break-words text-ink-2">{record.updatedAt}</span>
          </div>
          <div className="flex gap-3">
            <span className="w-24 shrink-0 text-ink-3">该类目商品</span>
            <span className="min-w-0 flex-1 break-words text-ink-2">
              <Link
                href={`/admin/products?gameId=${encodeURIComponent(record.gameId)}&categoryId=${encodeURIComponent(record.id)}`}
                className="text-admin-accent underline-offset-2 hover:underline"
              >
                在商品管理里查看这一类目下的商品
              </Link>
            </span>
          </div>
        </div>
      </section>

      <AdminCategoryForm
        key={version}
        record={record}
        games={games}
        message={formFlash}
        onSaved={(_result, text) => {
          setFormFlash(text);
          setActionFlash("");
          void fetchAdminCategory(record.id).then((fresh) => {
            setRecord(fresh);
            setVersion((value) => value + 1);
          });
        }}
      />

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${ADMIN_CATEGORY_ACTION_LABELS[pendingIntent]}这个类目` : ""}
        description={pendingIntent ? ADMIN_CATEGORY_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={pendingIntent ? `确认${ADMIN_CATEGORY_ACTION_LABELS[pendingIntent]}` : ""}
        tone={pendingIntent === "enable" ? "primary" : "danger"}
        pending={busy}
        error={confirmError}
        onConfirm={() => {
          const key = keyRef.current;
          if (key && pendingIntent) void runWrite(pendingIntent, key);
        }}
        onCancel={closeIntent}
      />
    </div>
  );
}
