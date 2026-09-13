"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminProductForm from "@/components/admin/AdminProductForm";
import AdminStatItem from "@/components/admin/AdminStatItem";
import AdminStatusBadge, { PRODUCT_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_PRODUCT_ACTION_LABELS,
  ADMIN_PRODUCT_CONFIRM_TEXTS,
  ADMIN_PRODUCT_READONLY_NOTICE,
  ADMIN_PRODUCT_REMOVED_MESSAGE,
  PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE,
  adminProductStatus,
} from "@/lib/constants/adminProducts";
import { formatYuan } from "@/lib/utils/format";
import {
  fetchAdminProduct,
  publishProduct,
  removeProduct,
  unpublishProduct,
} from "@/lib/services/adminHttp";
import type {
  AdminProductFormOptions,
  AdminProductListItem,
  AdminProductWriteResult,
} from "@/lib/types/product";

/** 需要二次确认的窄写入动作。 */
type StatusIntent = "publish" | "unpublish" | "remove";

const ACTION_SUCCESS_MESSAGE: Record<StatusIntent, string> = {
  publish:
    "已上架：用户端首页、分类页与详情页立刻可见，并且可以结算；上架要求至少保留一条有效规格",
  unpublish:
    "已下架：从用户端列表消失，直链打开显示「已下架」且不能结算；历史订单与收藏记录不受影响",
  remove:
    "已移除：用户端不再可见（直链也是 404），后台可用「使用中 / 已移除」筛选切换查看；历史订单、收藏与评价记录均已保留",
};

/**
 * 商品详情的**唯一写入口**：上下架 / 移除 + 编辑表单。
 *
 * 为什么两件事放在一个组件里：它们写的是同一条记录，而且都要在写成功后
 * 拿到**服务端的最新值**。分成两个组件各自刷新，就会出现「按钮已经把商品下架了，
 * 编辑表单里还写着上架」——保存时会把状态又改回去。这里统一成一条刷新路径：
 * **任何一次写成功都重新取一次详情**，表单用 `key` 重挂载，因此永远以服务端为准，
 * 而不是以「刚才那次请求的返回值」为准。
 *
 * ⚠️ 快捷动作走**窄写入**接口（只改状态），不是把整条记录写回去：
 * 「下架」不该顺带把标题、价格、规格覆盖成按钮渲染时的旧值。
 * 编辑表单则是**整份资料（含全部规格）的覆盖写**，两种语义对应两组接口，互不冒充。
 *
 * ⚠️ 所有危险动作都要二次确认，但确认框**不是防重手段**：
 * 真正的防重是每次提交带上的幂等键 + 服务端的状态判断（§九）。
 */
export default function AdminProductConsole({
  record: initialRecord,
  options,
}: {
  record: AdminProductListItem;
  /** 游戏、类目（含停用与已移除）、图片白名单，由服务端取数后传入 */
  options: AdminProductFormOptions;
}) {
  const [record, setRecord] = useState(initialRecord);
  /** 每次写成功后自增：编辑表单以它为 key 重挂载，从而以服务端最新值重新填表 */
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 状态动作的结果（显示在状态卡片里） */
  const [actionFlash, setActionFlash] = useState("");
  /** 编辑表单的保存结果（作为 prop 传给表单，它重挂载后仍然拿得到） */
  const [formFlash, setFormFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<StatusIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);

  const status = adminProductStatus(record);
  const removed = record.removedAt !== null;
  /**
   * 一件在架却没有有效规格的商品，点进去是一页买不了的东西，因此上架按钮先禁用。
   *
   * ⚠️ 这个数字来自**服务端返回的记录**，不是前端自己数规格数组：
   * 「有效」的口径（启用且未移除）只有服务端一处定义，前端再数一遍就会在
   * 某个边界上分叉。真正的拒绝也在服务端。
   */
  const publishBlocked = record.effectiveSpecCount === 0;

  async function runWrite(intent: StatusIntent, key: string) {
    setBusy(true);
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");

    try {
      const result: AdminProductWriteResult = await {
        publish: () => publishProduct(record.id, key),
        unpublish: () => unpublishProduct(record.id, key),
        remove: () => removeProduct(record.id, key),
      }[intent]();

      keyRef.current = null;
      setPendingIntent(null);

      // 无论服务端说「改了」还是「已经是这个状态」，都重新取一次详情：
      // 前端不拿响应里的几个字段自己拼出新状态，那会和真实记录分叉
      const fresh = await fetchAdminProduct(record.id);
      setRecord(fresh);
      setVersion((value) => value + 1);
      setActionFlash(
        result.changed ? ACTION_SUCCESS_MESSAGE[intent] : "这件商品已处于这个状态，未产生新的变更",
      );
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: StatusIntent) {
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
          <div className="flex min-w-0 items-start gap-3">
            <img
              src={record.coverUrl}
              alt=""
              className="h-16 w-24 shrink-0 rounded-lg border border-admin-line object-cover"
            />
            <div className="min-w-0">
              <p className="text-[16px] font-medium text-ink">{record.title}</p>
              {record.subtitle ? (
                <p className="text-[13px] text-ink-2">{record.subtitle}</p>
              ) : null}
              <p className="font-mono text-[12px] text-ink-3">{record.id}</p>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <AdminStatusBadge
              label={status.label}
              description={status.description}
              tone={PRODUCT_STATUS_TONE[status.key]}
            />
            {record.removedAt ? (
              <span className="text-[12px] text-ink-3">移除时间：{record.removedAt}</span>
            ) : null}
          </div>
        </div>

        <h2 className="mt-5 text-[15px] font-medium text-ink">状态操作</h2>
        {removed ? (
          <p className="mt-2 text-[13px] leading-5 text-ink-3">{ADMIN_PRODUCT_REMOVED_MESSAGE}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openIntent("publish")}
              disabled={record.status === "on" || publishBlocked}
              aria-describedby={publishBlocked ? "product-publish-blocked" : undefined}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
            >
              {ADMIN_PRODUCT_ACTION_LABELS.publish}
            </button>
            <button
              type="button"
              onClick={() => openIntent("unpublish")}
              disabled={record.status === "off"}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {ADMIN_PRODUCT_ACTION_LABELS.unpublish}
            </button>
            <button
              type="button"
              onClick={() => openIntent("remove")}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {ADMIN_PRODUCT_ACTION_LABELS.remove}
            </button>
          </div>
        )}

        {/* 不能上架时把**原因**说清楚，而不是只给一个灰按钮：
            灰按钮不解释自己，人会反复点它 */}
        {!removed && publishBlocked ? (
          <p id="product-publish-blocked" className="mt-2 text-[12px] leading-4 text-ink-3">
            {PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE}——目前 0 条有效规格，因此「上架」暂时不可用；
            请在下面的表单里启用或新增一条规格。
          </p>
        ) : null}

        <p className="mt-3 text-[12px] leading-4 text-ink-3">
          下架 = 从用户端列表消失、直链显示「已下架」且不能结算，随时可以再上架；
          移除 = 软删除，商品从用户端完全消失，记录保留、历史订单与收藏仍可追溯。
        </p>

        {actionFlash ? (
          <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
            {actionFlash}
          </p>
        ) : null}
      </section>

      {/* 只读区块：这些字段由系统维护，页面只能看 */}
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <h2 className="text-[15px] font-medium text-ink">统计与时间（只读）</h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">{ADMIN_PRODUCT_READONLY_NOTICE}</p>

        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <AdminStatItem
            label="起售价"
            value={record.effectiveSpecCount === 0 ? "—" : `¥${formatYuan(record.priceFrom)}`}
            hint="取有效规格里的最低价"
          />
          <AdminStatItem
            label="规格"
            value={`${record.effectiveSpecCount} / ${record.specCount}`}
            hint="有效 / 全部（含停用与已移除）"
          />
          <AdminStatItem label="月售" value={String(record.monthlySales)} hint="统计字段" />
          <AdminStatItem label="平台标签" value={record.gameTag} hint="与运营标签不同" />
        </dl>

        <div className="mt-4 flex flex-col gap-1 text-[13px]">
          <ReadonlyRow label="所属游戏">
            <span className="text-ink-2">{record.gameName}</span>
          </ReadonlyRow>
          <ReadonlyRow label="所属类目">
            <span className="text-ink-2">
              {record.categoryName || "（不属于任何类目，仅直链可访问）"}
            </span>
          </ReadonlyRow>
          <ReadonlyRow label="运营标签">
            <span className="text-ink-2">
              {record.tags.length === 0 ? "（无）" : record.tags.join("、")}
            </span>
          </ReadonlyRow>
          <ReadonlyRow label="创建时间">
            <span className="text-ink-2">{record.createdAt}</span>
          </ReadonlyRow>
          <ReadonlyRow label="最近更新">
            <span className="text-ink-2">{record.updatedAt}</span>
          </ReadonlyRow>
          <ReadonlyRow label="用户端">
            {/* 同一份数据：后台看到的与用户看到的是同一条记录，这里直接跳过去看 */}
            <Link
              href={`/product/${encodeURIComponent(record.id)}`}
              target="_blank"
              rel="noreferrer"
              className="text-admin-accent underline-offset-2 hover:underline"
            >
              在用户端打开这件商品（新标签页）
            </Link>
          </ReadonlyRow>
        </div>
      </section>

      <AdminProductForm
        key={version}
        record={record}
        options={options}
        message={formFlash}
        onSaved={(_result, text) => {
          setFormFlash(text);
          setActionFlash("");
          void fetchAdminProduct(record.id).then((fresh) => {
            setRecord(fresh);
            setVersion((value) => value + 1);
          });
        }}
      />

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${ADMIN_PRODUCT_ACTION_LABELS[pendingIntent]}这件商品` : ""}
        description={pendingIntent ? ADMIN_PRODUCT_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={pendingIntent ? `确认${ADMIN_PRODUCT_ACTION_LABELS[pendingIntent]}` : ""}
        // 上架是可恢复的常规动作，下架与移除会让商品从用户端消失——色调据此分开
        tone={pendingIntent === "publish" ? "primary" : "danger"}
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

/** 只读区块里的一行「标签 + 内容」。标签定宽，多行内容左对齐成一条线。 */
function ReadonlyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}
