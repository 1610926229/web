import { toComplaintAuditSnapshot } from "@/lib/constants/adminAudit";
import { canTransitionComplaint } from "@/lib/constants/adminComplaints";
import type { Complaint, ComplaintStatus } from "@/lib/types/complaint";
import { takeReplay, writeAudit, type AdminWriteContext } from "./adminWriteSupport";
import { applyComplaintStatus, complaintStore } from "./mockComplaintRepository";

/**
 * 管理端投诉处理的**伪事务** —— 三个处理动作的唯一写入入口。
 *
 * ## 为什么需要这一层
 *
 * §投诉处理 要求每个动作「改状态 + 写处理信息 + 写一条审计」在同一段同步代码里完成，
 * 而且重复点击、重试或并发请求**不得重复迁移状态、也不得重复审计**。
 * 这里用的办法与另外两组事务完全一致：**把读—判断—写的全过程放进一段没有 `await` 的同步代码**。
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**。store 句柄每次现取，绝不缓存
 * （测试里 `resetMockStore()` 会换掉整份存储）。
 *
 * ## 三条业务边界（§投诉处理）
 *
 * 1. **投诉不自动修改订单，也不自动退款**：本文件里**没有一行**订单或退款代码，
 *    连 import 都没有。这不是「暂时没写」，而是做不出来——没有可用的句柄。
 * 2. **用户提交的内容不可被覆盖**：正文、凭证、联系方式只在读取时被 `toComplaintAuditSnapshot`
 *    收纳成计数（见 `lib/constants/adminAudit.ts`），写入侧（`applyComplaintStatus`）
 *    根本没有写它们的位置。
 * 3. **解决必须填写处理结果、关闭必须填写关闭说明**：校验在常量层一处
 *    （`normalizeAdminComplaintResult`），服务层校验通过后才把文本传进来。
 *
 * 接入真实数据库后，本文件整体替换为一个事务，上层的 service 与接口一行都不用改。
 */

/** 写上下文由 `./adminWriteSupport` 定义；这里再导出一次，调用方的既有引用不用改。 */
export type { AdminWriteContext };

/** 投诉处理写操作的失败情形。文案由服务层翻译，数据层不产生界面文案。 */
export type AdminComplaintWriteFailure =
  /** 目标不存在 */
  | { kind: "not-found" }
  /** 状态机不允许这次迁移，携带当前状态 */
  | { kind: "invalid-transition"; status: ComplaintStatus }
  /**
   * 这个幂等键已经被**另一个对象**用过。
   *
   * 客户端复用了幂等键属于调用方的 bug；此时安静地重放会返回另一个对象的操作结果，
   * 比报错危险得多。因此单独分出来，由服务层转成一个明确的 400。
   */
  | { kind: "operation-conflict" };

export type AdminComplaintWriteResult =
  | {
      kind: "ok";
      value: { complaint: Complaint };
      /** 这一次是否真的改动了数据 */
      changed: boolean;
      /** 是否是幂等重放（同一个幂等键第二次到达） */
      replayed: boolean;
    }
  | AdminComplaintWriteFailure;

/** 一次投诉处理动作的目标状态。与三个服务函数一一对应。 */
export type AdminComplaintIntent = "start-processing" | "resolve" | "close";

/** 意图 → 目标状态。**这是全站唯一的一处映射**，服务层与审计动作都从它推导。 */
const INTENT_TO_STATUS: Record<
  AdminComplaintIntent,
  Extract<ComplaintStatus, "processing" | "resolved" | "closed">
> = {
  "start-processing": "processing",
  resolve: "resolved",
  close: "closed",
};

/**
 * 三个处理动作的**唯一写入路径**。
 *
 * 它们共用一段实现而不是各写一份，是因为三者的差别只有两处：目标状态，以及
 * 要不要写处理结果。各写一份的话，「幂等重放返回什么」在三个函数里迟早会有三种答案，
 * 而这类差异只在重试或并发时才会暴露。
 *
 * `result` 只在 `resolve` / `close` 时被写入：
 * - `start-processing` 时它被忽略（连读都不读）——开始处理没有结论，
 *   把提交上来的文本写进去会变成一条「处理中但已经有结果」的记录；
 * - 另外两个动作的文本由服务层按各自的必填规则校验过。
 */
export async function applyAdminComplaintIntent(
  complaintId: string,
  intent: AdminComplaintIntent,
  result: string,
  ctx: AdminWriteContext,
): Promise<AdminComplaintWriteResult> {
  const complaints = complaintStore();
  const to = INTENT_TO_STATUS[intent];
  const action = auditActionOf(intent);

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx.operationId, "complaint", complaintId);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = complaints.complaints.get(complaintId);
  if (!existing) return { kind: "not-found" };

  // 重放：这个键已经成功过一次，原样返回当前状态，**不再写任何东西**
  if (replay?.kind === "replay") {
    return { kind: "ok", value: { complaint: { ...existing } }, changed: false, replayed: true };
  }

  if (!canTransitionComplaint(existing.status, to)) {
    return { kind: "invalid-transition", status: existing.status };
  }

  const written = applyComplaintStatus(complaintId, to, {
    at: ctx.at,
    result,
    adminId: ctx.adminId,
  });
  // 上面刚确认过记录存在，这里为 null 属于不可能状态；当作失败返回，绝不继续写
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "complaint",
    targetId: complaintId,
    before: toComplaintAuditSnapshot(written.previous),
    after: toComplaintAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: { complaint: written.updated }, changed: true, replayed: false };
}

/**
 * 意图 → 审计动作。
 *
 * 与 `INTENT_TO_STATUS` 分开写而不是从状态反推：两者恰好一一对应，但**含义不同**——
 * 一个是「记录变成了什么」，一个是「管理者做了什么」。将来若新增一个能到达
 * `closed` 的动作，状态反推会把两条审计记成同一件事。
 */
function auditActionOf(intent: AdminComplaintIntent): Parameters<typeof writeAudit>[0]["action"] {
  switch (intent) {
    case "start-processing":
      return "complaint.start-processing";
    case "resolve":
      return "complaint.resolve";
    default:
      return "complaint.close";
  }
}
