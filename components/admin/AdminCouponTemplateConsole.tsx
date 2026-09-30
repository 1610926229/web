"use client";

import { useRef, useState } from "react";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminCouponTemplateForm from "@/components/admin/AdminCouponTemplateForm";
import AdminStatItem from "@/components/admin/AdminStatItem";
import AdminStatusBadge, { COUPON_TEMPLATE_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_COUPON_ACTION_LABELS,
  ADMIN_COUPON_COMPUTABLE_NOTICE,
  ADMIN_COUPON_CONFIRM_TEXTS,
  ADMIN_COUPON_NOT_EDITABLE_MESSAGE,
  ADMIN_COUPON_TEMPLATE_NOTICE,
  adminCouponTemplateStatus,
} from "@/lib/constants/adminCoupons";
import { disableCouponTemplate, enableCouponTemplate, fetchAdminCouponTemplate } from "@/lib/services/adminHttp";
import type { AdminCouponTemplateItem, AdminCouponTemplateWriteResult } from "@/lib/types/coupon";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

const FLAG_SUCCESS_MESSAGE = {
  enable: "已启用：这张券重新出现在领券中心，也可以被后台发放",
  disable:
    "已停用：不能再被领取或发放，已经领到手的用户也无法再用它核销；券本身与历史订单不受影响",
} as const;

function amountText(fen: number | null): string {
  return fen === null ? "—" : `¥${formatYuan(fen)}`;
}

/**
 * 券模板详情的**唯一写入口**：状态动作 + 编辑表单。
 *
 * 为什么两件事放在一个组件里：它们写的是同一条记录，而且都要在写成功后
 * 拿到**服务端的最新值**。分成两个组件各自刷新，就会出现「按钮已经把券停用了，
 * 编辑表单里还写着启用」——表单提交时会把状态又改回去。
 * 这里统一成一条刷新路径：**任何一次写成功都重新取一次详情**，
 * 表单用 `key` 重挂载，因此永远以服务端为准，而不是以「刚才那次请求的返回值」为准。
 *
 * ⚠️ 快捷动作走**窄写入**接口（只改一个字段），不是把整条记录写回去：
 * 「停用」不该顺带把名称、金额、有效期覆盖成按钮渲染时的旧值。
 * 编辑表单则是**整份资料的覆盖写**，两种语义对应两个接口，互不冒充。
 *
 * ⚠️ **非满减券没有编辑表单**：`record.editable` 由服务端算好，为 `false` 时
 * 这里只给状态操作与一段解释（§1：折扣券与无门槛券不参与结算，改它们的金额没有去向）。
 * 启停**仍然可用**——它们是历史模板，可以展示、可以启停，只是不进结算。
 *
 * ⚠️ 所有危险动作都要二次确认，但确认框**不是防重手段**：
 * 真正的防重是每次提交带上的幂等键 + 服务端的状态判断（§九）。
 */
export default function AdminCouponTemplateConsole({
  record: initialRecord,
}: {
  record: AdminCouponTemplateItem;
}) {
  const [record, setRecord] = useState(initialRecord);
  /** 每次写成功后自增：编辑表单以它为 key 重挂载，从而以服务端最新值重新填表 */
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 状态动作的结果（显示在状态卡片里） */
  const [actionFlash, setActionFlash] = useState("");
  /** 编辑表单的保存结果（作为 prop 传给表单，它重挂载后仍然拿得到） */
  const [formFlash, setFormFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<"enable" | "disable" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);

  const status = adminCouponTemplateStatus(record);

  async function runWrite(intent: "enable" | "disable", key: string) {
    setBusy(true);
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");

    try {
      const result: AdminCouponTemplateWriteResult =
        intent === "enable"
          ? await enableCouponTemplate(record.id, key)
          : await disableCouponTemplate(record.id, key);

      keyRef.current = null;
      setPendingIntent(null);

      // 无论服务端说「改了」还是「已经是这个状态」，都重新取一次详情：
      // 前端不拿响应里的几个字段自己拼出新状态，那会和真实记录分叉
      const fresh = await fetchAdminCouponTemplate(record.id);
      setRecord(fresh);
      setVersion((value) => value + 1);
      setActionFlash(
        result.changed ? FLAG_SUCCESS_MESSAGE[intent] : "这张券已处于这个状态，未产生新的变更",
      );
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: "enable" | "disable") {
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
            <p className="mt-1 text-[13px] text-ink-2">
              {record.valueLabel} · {record.conditionLabel}
            </p>
          </div>

          <AdminStatusBadge
            label={status.label}
            description={status.description}
            tone={COUPON_TEMPLATE_STATUS_TONE[status.key]}
          />
        </div>

        {/* 状态动作 */}
        <h2 className="mt-5 text-[15px] font-medium text-ink">状态操作</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => openIntent("disable")}
            disabled={!record.enabled}
            className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
          >
            {ADMIN_COUPON_ACTION_LABELS.disable}
          </button>
          <button
            type="button"
            onClick={() => openIntent("enable")}
            disabled={record.enabled}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
          >
            {ADMIN_COUPON_ACTION_LABELS.enable}
          </button>
        </div>

        <p className="mt-3 text-[12px] leading-4 text-ink-3">
          停用 = 不能再被领取或发放，**已经领到手的用户也无法再用它核销**，券本身与历史订单不受影响；
          启用 = 重新出现在领券中心，可以被后台发放。本轮**不提供删除**：券的生命周期止于停用。
        </p>

        {actionFlash ? (
          <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
            {actionFlash}
          </p>
        ) : null}
      </section>

      {/* 只读区块：这些字段由系统维护，页面只能看 */}
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <h2 className="text-[15px] font-medium text-ink">金额与时间（只读）</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <AdminStatItem
            label="满减门槛"
            value={amountText(record.thresholdAmount)}
            hint="订单金额达到这个数额才可用"
          />
          <AdminStatItem
            label="优惠金额"
            value={amountText(record.discountAmount)}
            hint="结算时抵扣的金额"
          />
          <AdminStatItem label="形式" value={record.formLabel} hint={record.editable ? "参与结算" : "不参与结算"} />
          <AdminStatItem label="已领取" value={String(record.claimCount)} hint="张，含已使用与已作废" />
          <AdminStatItem label="有效期开始" value={formatDateTime(record.validFrom)} />
          <AdminStatItem label="有效期结束" value={formatDateTime(record.validTo)} />
          <AdminStatItem label="建档时间" value={formatDateTime(record.createdAt)} />
          <AdminStatItem label="最近更新" value={formatDateTime(record.updatedAt)} />
        </dl>

        <p className="mt-4 text-[12px] leading-4 text-ink-3">{ADMIN_COUPON_TEMPLATE_NOTICE}</p>
      </section>

      {record.editable ? (
        <AdminCouponTemplateForm
          key={version}
          record={record}
          message={formFlash}
          onSaved={(_result, text) => {
            setFormFlash(text);
            setActionFlash("");
            void fetchAdminCouponTemplate(record.id).then((fresh) => {
              setRecord(fresh);
              setVersion((value) => value + 1);
            });
          }}
        />
      ) : (
        <section className="rounded-xl border border-admin-line bg-surface p-4">
          <h2 className="text-[15px] font-medium text-ink">不可编辑</h2>
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            {ADMIN_COUPON_NOT_EDITABLE_MESSAGE}
          </p>
          <p className="mt-2 text-[12px] leading-4 text-ink-3">{ADMIN_COUPON_COMPUTABLE_NOTICE}</p>
        </section>
      )}

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${ADMIN_COUPON_ACTION_LABELS[pendingIntent]}这张优惠券` : ""}
        description={
          pendingIntent
            ? pendingIntent === "enable"
              ? ADMIN_COUPON_CONFIRM_TEXTS.enable
              : ADMIN_COUPON_CONFIRM_TEXTS.disable
            : ""
        }
        confirmLabel={pendingIntent ? `确认${ADMIN_COUPON_ACTION_LABELS[pendingIntent]}` : ""}
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
