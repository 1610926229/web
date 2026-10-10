import { toCouponAuditSnapshot } from "@/lib/constants/adminAudit";
import {
  ADMIN_COUPON_TEMPLATE_FORM_KEY,
  ADMIN_COUPON_TEMPLATE_FORM_LABEL,
  adminCouponTemplateActionFromPatch,
  isCouponTemplateUnchanged,
  type CouponTemplateDraft,
} from "@/lib/constants/adminCoupons";
import { buildThresholdCouponLabels, isComputableCouponForm } from "@/lib/constants/coupons";
import type { Coupon } from "@/lib/types/coupon";
import type { AdminWriteContext } from "./adminWriteSupport";
import { nextRecordId, takeCreateReplay, takeReplay, writeAudit } from "./adminWriteSupport";
import {
  applyCouponEnabled,
  applyCouponPatch,
  couponStore,
  createCouponRecord,
} from "./mockCouponRepository";

/**
 * 券模板写入的**伪事务** —— 本阶段新建 / 编辑 / 启停一张券模板的唯一写入入口（P1-6）。
 *
 * ## 为什么需要这一层
 *
 * 「重复或并发请求不得产生重复的改动或审计」这条要求横跨「券模板」与「审计」两张表，
 * 仓库里没有事务可用，于是这里用一件事替代：**把读—判断—写的全过程放进一段
 * 没有 `await` 的同步代码**。
 *
 * Node 是单线程的，同步区段一旦开始就会跑完，中间不可能被另一个请求插入
 * （`await` 才是让出执行权的唯一时刻）。因此这段代码在并发下与真事务等价：
 * 两个同时到达的「同一个幂等键保存券模板」请求，第二个进来时第一个已经全部写完，
 * 它读到的是**已经存在**的审计记录，于是走重放路径而不是又改一次。
 *
 * ⚠️ **因此本文件里出现 `await` 就是 bug**：哪怕加一个 `await Promise.resolve()`
 * 都会让出执行权，原子性立刻消失。store 句柄在区段之外（函数开头）取好，
 * 区段内只做同步的读写。下面这几个函数虽然声明成 `async`（调用方要 `await` 它们），
 * 但**函数体里一个 `await` 都没有**，从第一行到 `return` 之间不会让出执行权。
 *
 * ⚠️ store 句柄**每次调用现取，绝不缓存**：测试里 `resetMockStore()` 会换掉整份存储，
 * 缓存下来的对象会变成孤儿，写入看不见、读到的还是旧数据。
 *
 * ⚠️ 本文件**只改券模板（`Coupon`）**，一行都不碰 `CouponClaim`：
 * §5 明文停用不删除已发出的 Claim，§"编辑不追溯" 明文改模板不回写快照。
 * 因此这里根本没有「顺带更新一下用户手里的券」这种代码的位置。
 *
 * 接入真实数据库后，本文件整体替换为一个事务（`BEGIN … COMMIT` + `operation_id`
 * 唯一索引），上层的 service 与接口一行都不用改。
 *
 * ## 与平台参数那份伪事务的两处不同
 *
 * 1. **多了 `not-found`**：券模板是多条记录，可以指向一条不存在的 id；
 * 2. **多了 `not-editable`**：非满减券可以被停用、不能被编辑（§1）。
 *    这一条必须在原子区段里判——它要读**当前**记录的 `formKey`，
 *    而服务层手上那份可能是别的时刻读出来的。
 *
 * ## 「什么都没改」为什么不算一次操作
 *
 * 管理员点了一次保存而值没变时，不写数据、不写审计、**不刷新 `updatedAt`**。
 * 「最后修改时间刚刚变过」是一个会被当作证据的字段——它一变，
 * 事后追查的人就会去找一次并不存在的改动。
 */

export type { AdminWriteContext };

/** 本模块写操作的失败情形。`operation-conflict` 的理由见 `takeReplay` 的注释。 */
export type AdminCouponTemplateWriteFailure =
  /** 目标模板不存在 */
  | { kind: "not-found" }
  /** 这个幂等键已经被**另一个操作者或另一个对象**用过 */
  | { kind: "operation-conflict" }
  /** 只有满减券可以编辑（§1）。停用/启用不受此限 */
  | { kind: "not-editable" };

/**
 * 一次券模板写入的结果。
 *
 * 三种「成功」刻意分开（与本仓其它伪事务同一套口径）：
 * - `changed: true` —— 真的改了数据，也写了审计；
 * - `changed: false, replayed: false` —— **提交的值与现状一模一样**；
 * - `changed: false, replayed: true` —— 同一个幂等键第二次到达。
 *
 * `value.previous` 在**新建**时为 `null`（这条记录原本不存在）。
 */
export type AdminCouponTemplateWriteOutcome =
  | {
      kind: "ok";
      value: { previous: Coupon | null; updated: Coupon };
      changed: boolean;
      replayed: boolean;
    }
  | AdminCouponTemplateWriteFailure;

// ——————————————————————————— 新建 ———————————————————————————

/**
 * 新建券模板（§1：**只可能是满减券**）。
 *
 * ⚠️ 形态与文案都由**服务端**钉死：`formKey` 取常量，`valueLabel` / `conditionLabel`
 * 由 `buildThresholdCouponLabels()` 从两个金额派生（§3）。
 * 调用方（服务层）传进来的 `draft` 里根本没有这三个字段的位置。
 *
 * 「同一个幂等键第二次到达」在这里必须靠**操作类型**识别，而不是靠目标 id：
 * 新建的目标 id 是在原子区段里当场生成的，第二次调用会生成一个不同的 id，
 * 按 id 比对只会把它误判成「幂等键被别的对象用了」。`takeCreateReplay()` 因此
 * 只认「这个键已经被同类型的对象用过」，再拿审计里记下的 id 把当时那条记录找回来。
 *
 * ⚠️ **由此产生一条对调用方的要求：同一个幂等键只能用于一类动作。**
 * 收窄只有「操作者 × 目标类型」两轴，因此同一个键若先被**新建以外**的券操作
 * （启停走的是同一个 `targetType: "coupon"`）用掉，再来新建会被判成重放，
 * 返回的是那张**已存在的**券的 id 与 200——一次没有发生的创建被报成成功。
 * 服务层每次操作都用 `crypto.randomUUID()` 现取新键，因此真实路径不会撞上；
 * 但这是**调用方的义务**，不是本函数能替它保证的事。
 *
 * ⚠️ `draft` 的值**由调用方保证已通过 `couponTemplateFieldErrors()`**。
 * 本函数不做校验、更不做夹取：一个「顺手夹到合法范围」的实现会让一条本该被拒绝的
 * 输入被静默改成另一个数字写进去，调用方拿到「成功」而生效的是另一个值。
 * 校验在服务层（`lib/services/adminCouponTemplates.ts`）。
 */
export async function createCouponTemplate(
  draft: CouponTemplateDraft,
  ctx: AdminWriteContext,
): Promise<AdminCouponTemplateWriteOutcome> {
  // store 句柄在原子区段**之外**取好：取句柄本身是同步的，但它不该出现在
  // 「读—判断—写」之间，否则区段里就多了一处与业务无关的代码
  const store = couponStore();

  // —— 原子区段开始（无 await）——
  const replay = takeCreateReplay(ctx, "coupon");
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  if (replay) {
    const existing = store.coupons.get(replay.targetId);
    // 审计里有、记录却没有：数据被清过。宁可报「不存在」，也不编一条出来
    if (!existing) return { kind: "not-found" };
    return {
      kind: "ok",
      value: { previous: null, updated: { ...existing } },
      changed: false,
      replayed: true,
    };
  }

  const labels = buildThresholdCouponLabels(draft.thresholdAmount, draft.discountAmount);

  const created = createCouponRecord({
    id: nextRecordId("cpn_", (candidate) => store.coupons.has(candidate), "优惠券"),
    // 形态由服务端钉死，不由调用方决定（§1）
    formKey: ADMIN_COUPON_TEMPLATE_FORM_KEY,
    formLabel: ADMIN_COUPON_TEMPLATE_FORM_LABEL,
    name: draft.name.trim(),
    // 文案由金额派生，不由调用方提交（§3）
    valueLabel: labels.valueLabel,
    conditionLabel: labels.conditionLabel,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    enabled: draft.enabled,
    thresholdAmount: draft.thresholdAmount,
    discountAmount: draft.discountAmount,
    // 建档与最后改动是同一个时刻：这条记录就是现在产生的
    createdAt: ctx.at,
    updatedAt: ctx.at,
  });

  writeAudit({
    ctx,
    action: "coupon.create",
    targetType: "coupon",
    targetId: created.id,
    before: null,
    after: toCouponAuditSnapshot(created),
  });
  // —— 原子区段结束 ——

  return {
    kind: "ok",
    value: { previous: null, updated: created },
    changed: true,
    replayed: false,
  };
}

// ——————————————————————————— 编辑 ———————————————————————————

/**
 * 编辑券模板（名称 / 门槛 / 优惠金额 / 有效期 / 启用状态，一次保存）。
 *
 * ⚠️ **非满减券一律拒绝**（§1「只允许新建 / 编辑 `threshold`」）。
 * 判据是**当前记录**的 `formKey`，不是调用方传进来的任何东西——
 * 一张折扣券不会因为请求体里写了 `formKey: "threshold"` 就变得可以编辑。
 *
 * ⚠️ **不追溯已发出的 Claim**（§5）：本函数只改 `store.coupons` 这一张表。
 * 用户手里的券是 `CouponClaim.snapshot`，它在领取那一刻就冻结了。
 *
 * ⚠️ **文案重新派生**：`valueLabel` / `conditionLabel` 由**新**的两个金额算出来。
 * 这不是「顺手更新一下」，而是「文案与金额是同一份数据的两种呈现」（§3）——
 * 改了金额却留着旧文案，就会在用户端显示「满 100 减 10」而实际抵扣别的数。
 */
export async function updateCouponTemplate(
  id: string,
  draft: CouponTemplateDraft,
  ctx: AdminWriteContext,
): Promise<AdminCouponTemplateWriteOutcome> {
  const store = couponStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "coupon", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = store.coupons.get(id);
  if (!existing) return { kind: "not-found" };
  // 形态先判：一张折扣券上连「编辑」按钮都不该有，走到这里说明调用方绕过了界面
  if (!isComputableCouponForm(existing.formKey)) return { kind: "not-editable" };

  const action = adminCouponTemplateActionFromPatch(existing, draft);
  const next = {
    name: draft.name.trim(),
    thresholdAmount: draft.thresholdAmount,
    discountAmount: draft.discountAmount,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    enabled: draft.enabled,
  };

  // 两种「什么都没发生」都不写数据、不写审计、也不刷新时间戳，且**都不是错误**
  if (replay?.kind === "replay" || isCouponTemplateUnchanged(existing, next)) {
    return {
      kind: "ok",
      // 两份互不相关的副本，而不是同一个对象的两个别名
      value: { previous: { ...existing }, updated: { ...existing } },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const labels = buildThresholdCouponLabels(next.thresholdAmount, next.discountAmount);

  const written = applyCouponPatch(id, {
    ...next,
    // 文案与金额从同一次计算里出来，不可能对不上（§3）
    valueLabel: labels.valueLabel,
    conditionLabel: labels.conditionLabel,
    at: ctx.at,
  });
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "coupon",
    targetId: id,
    before: toCouponAuditSnapshot(written.previous),
    after: toCouponAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: written, changed: true, replayed: false };
}

// ——————————————————————————— 启用 / 停用 ———————————————————————————

/**
 * 启用 / 停用券模板（**窄写入**：只改这一个字段）。
 *
 * ⚠️ 与 `updateCouponTemplate()` 分开，是因为它**不该碰名称、金额与有效期**：
 * 详情页上的开关只应当改启用状态。走「先读出来、拼一个完整 patch 再保存」的话，
 * 两位管理员同时操作时，后写的那次会把另一位刚改好的金额覆盖回旧值。
 *
 * ⚠️ **对所有形态都开放**（与「编辑」不同）：折扣券与无门槛券虽然不能改内容，
 * 但「平台现在还要不要兑现它」是一个必须能回答的问题（§5）。
 *
 * ⚠️ **没有前置条件**：§5 明文 disable 不删除 Claim、不改变历史订单，
 * 因此「已经有多少人领过」不是拒绝停用的理由——它是列表上给管理员看的提示。
 *
 * ## 幂等在这里是**两轴**的
 *
 * 用 `takeReplay()` 而不是 `takeReplayForAction()`：本动作的**意图由入参决定**
 * （`enabled` 就是意图本身），而同一个入参第二次到达本来就该是「重放」。
 * 反过来，同一个键先用于启用、再用于停用，会 `takeReplay()` 判成重放——
 * 但那种调用是**调用方复用了幂等键**，两次意图里后一次什么都没做。
 * 这与 `takeReplayForAction` 的注释说明的取舍是同一件事的另一面：
 * 那里的动作名要在读完记录后才算得出来，这里的动作名在调用前就定死了，
 * 因此**不需要**再收一轴——入参没变就一定是同一个意图。
 */
export async function setCouponTemplateEnabled(
  id: string,
  enabled: boolean,
  ctx: AdminWriteContext,
): Promise<AdminCouponTemplateWriteOutcome> {
  const store = couponStore();

  // —— 原子区段开始（无 await）——
  const replay = takeReplay(ctx, "coupon", id);
  if (replay?.kind === "conflict") return { kind: "operation-conflict" };

  const existing = store.coupons.get(id);
  if (!existing) return { kind: "not-found" };

  const action = enabled ? "coupon.enable" : "coupon.disable";

  // 已经就是那个状态：不写数据、不写审计、不刷新时间戳，且**不是错误**。
  // 「再停用一次一张已停用的券」不是失败——它已经是调用方想要的样子
  if (replay?.kind === "replay" || existing.enabled === enabled) {
    return {
      kind: "ok",
      value: { previous: { ...existing }, updated: { ...existing } },
      changed: false,
      replayed: replay?.kind === "replay",
    };
  }

  const written = applyCouponEnabled(id, enabled, ctx.at);
  if (!written) return { kind: "not-found" };

  writeAudit({
    ctx,
    action,
    targetType: "coupon",
    targetId: id,
    before: toCouponAuditSnapshot(written.previous),
    after: toCouponAuditSnapshot(written.updated),
  });
  // —— 原子区段结束 ——

  return { kind: "ok", value: written, changed: true, replayed: false };
}
