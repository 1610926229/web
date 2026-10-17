import assert from "node:assert/strict";
import test from "node:test";

import {
  previewRefundDecisionAmounts,
  readAdminRefundDecisionInput,
} from "../lib/constants/adminRefunds.ts";
// ⚠️ 公式与两句失败文案住在**规则层**（`lib/constants/refunds.ts`），
// `adminRefunds` 只是引用它们（`import { … }` 不等于再导出）。
// 断言「这里返回的 message 就是那一句冻结的常量」必须 import 那一份定义，
// 而不是在测试里另抄一个字面量——抄一份就等于允许两处将来不一样。
import {
  REFUND_DECISION_RATE_INVALID_MESSAGE,
  REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  computeRefundDecisionAmounts,
} from "../lib/constants/refunds.ts";
import { approveRefund } from "../lib/services/adminHttp.ts";

/**
 * 审核通过退款的**请求体键集合**门禁（P0-14 验收整改建立 · **P0-15 收敛为白名单**）。
 *
 * ## 这条测试守的是什么
 *
 * P0-15（产品负责人 2026-09-28）之后，资金决策的**唯一**输入是一个比例：
 *
 * ```text
 * refundAmount      = floor(actualPaidAmount × refundRateBp / 10000)
 * companionReversal = companionBaseIncome          // 整笔，不乘比例
 * platformNetIncome = actualPaidAmount − refundAmount
 * ```
 *
 * 两个维度（`refundFullRemaining` 二选一 × `responsibility` 三选一）连同
 * `companionLiabilityRatePercent` / `platformBorneAmount` **整体废止**
 * （`lib/types/refund.ts` 顶部那张表、`lib/constants/refunds.ts` 的规则块）。
 * 因此请求体**只有一个形态**：
 *
 * ```jsonc
 * { "idempotencyKey": "…", "reviewNote": "…", "refundRatePercent": "33" }
 * ```
 *
 * **一个不多、一个不少。** 这条测试断言的就是这两个方向：
 *
 * - **不少**：`refundRatePercent` 必须真的出现在序列化之后的 JSON 里。
 *   客户端把它写成 `refundRatePercent: undefined` 之类的空值时，
 *   `JSON.stringify` 会**整个丢掉这个键**，服务端于是收到「没填比例」→ 400
 *   「请填写退款比例」，而界面看起来完全正常；
 * - **不多**：已废止的键（`refundFullRemaining` / `responsibility` /
 *   `companionLiabilityRatePercent` / `refundAmount` / `platformBorneAmount`）
 *   **不得**顺着请求体出去。它们的语义已经不存在了，`refundAmount` 更是
 *   一条「管理员不能直接填金额」的红线（`architecture-rules.md` §三）。
 *
 * ⚠️ 因此这里的断言必须是**键在不在**（`in` / `Object.keys` / `deepEqual` 整个键数组），
 * **不能**写成 `assert.equal(body.refundRatePercent, undefined)`：
 * 后者对「键被丢掉」与「键在但值是 undefined」**同样为真**，钉不住这个缺陷。
 * 读序列化之后的字符串（`JSON.parse(init.body)`）是唯一看得见这件事的位置。
 *
 * ## 为什么还要单独测一次服务端读取
 *
 * 客户端只挑三个字段出去，只能证明**这一版客户端**干净。服务端那一侧必须
 * **独立地**证明「已废止的键翻不动任何东西」：`readAdminRefundDecisionInput`
 * 是写入路径上唯一解析资金决策的地方（`lib/services/adminRefunds.ts:394`），
 * 只要它只认 `refundRatePercent`，那么即便将来有人在路由里加一段
 * 「兼容旧客户端的 `refundFullRemaining`」分支，这里也会红——
 * 那正是本文件后半段那两条用例存在的理由。
 *
 * ## 为什么能用 `globalThis.fetch` 打桩
 *
 * `lib/api/client.ts` 是浏览器端唯一的 HTTP 出口，但没有浏览器专属依赖
 * （`withMockParams()` 里 `window` 已判空，node 下原样返回路径），
 * 因此截住 `fetch` 就能读到序列化后的请求体。先例：
 * `tests/staffComplaintCrossRole.test.mjs:298-313`。
 */

const REFUND_ID = "rf-body-1";
const IDEMPOTENCY_KEY = "idem-body-1";
const REVIEW_NOTE = "验收整改回归：请求体必须带上资金决策";
const APPROVE_PATH = `/api/admin/refunds/${REFUND_ID}/approve`;

/**
 * P0-15 起**已废止**的请求体键。
 *
 * ⚠️ 每个都写一句它当年的含义，是为了让「它为什么会混进来」这件事可读：
 * 它们不是拼写错误，而是一整代规则留下的字段，正因如此才最容易被顺手加回来。
 */
const ABOLISHED_BODY_KEYS = [
  /** 「退满剩余」——多步部分退款补尾差用的开关。一单一退之后尾差不存在，全额 = 比例 100 */
  "refundFullRemaining",
  /** 「平台 / 打手 / 分担」——责任模型已整体废止 */
  "responsibility",
  /** 只有 `shared` 才有值；`shared` 已不存在 */
  "companionLiabilityRatePercent",
  /** 金额从来不许由调用方给（P0-13），这条红线与责任模型无关，一并钉住 */
  "refundAmount",
  /** 「本次退款里平台担了多少」——新口径问的是「平台最终剩多少」，现算 */
  "platformBorneAmount",
];

/** 截住一次 `approveRefund()` 的请求，返回**序列化之后**解析回来的请求体。 */
async function captureApproveBody(decision) {
  const originalFetch = globalThis.fetch;
  const captured = [];

  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true } }),
    };
  };

  try {
    await approveRefund(REFUND_ID, IDEMPOTENCY_KEY, REVIEW_NOTE, decision);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 自检：断言的对象确实是这次审核通过的请求，否则后面的键集合断言没有意义
  assert.equal(captured.length, 1, "应当恰好发出一次请求");
  assert.equal(captured[0].init.method, "POST");
  assert.equal(captured[0].url, APPROVE_PATH);

  const raw = captured[0].init.body;
  assert.equal(typeof raw, "string", "请求体应当是 JSON 字符串");

  return JSON.parse(raw);
}

/** 键集合比较：顺序无关，多的少的一律红。 */
function keysOf(body) {
  return Object.keys(body).sort();
}

/** 那一份**恰好三个键**的期望键集合。P0-15 之后请求体只有这一个形态。 */
const EXPECTED_BODY_KEYS = ["idempotencyKey", "refundRatePercent", "reviewNote"];

test("请求体白名单：恰好 idempotencyKey / reviewNote / refundRatePercent 三个键", async () => {
  const body = await captureApproveBody({ refundRatePercent: "100" });

  assert.deepEqual(
    keysOf(body),
    EXPECTED_BODY_KEYS,
    "请求体的键集合变了：多出来的可能是已废止的维度，少掉的是服务端唯一认得的那个比例",
  );

  // 三个值各自核对一遍：键在、且是**这一次**的决策
  assert.equal(body.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(body.reviewNote, REVIEW_NOTE);
  assert.equal(body.refundRatePercent, "100", "全额退款就是比例 100，没有第二种表达方式");

  // `in` 与 `Object.keys` 是同一件事的两种读法，这里再点名一次是为了让
  // 「键被 JSON.stringify 丢掉」这个缺陷在断言里有一处专门的落点
  assert.equal(
    "refundRatePercent" in body,
    true,
    "比例必须真的发出去：漏了这个键，服务端只看到「没填比例」→ 400",
  );
});

test("已废止的键不得顺着请求体出去：即便调用方硬塞进来，客户端也只挑那三个字段", async () => {
  // 一半比例 + 全部已废止的键：它们必须**一个都到不了**服务端
  const body = await captureApproveBody({
    refundRatePercent: "33",
    refundFullRemaining: true,
    responsibility: "shared",
    companionLiabilityRatePercent: "50",
    refundAmount: 1,
    platformBorneAmount: 1,
  });

  assert.deepEqual(
    keysOf(body),
    EXPECTED_BODY_KEYS,
    "请求体多出了旧字段：服务端会收到一个它已经不再认识的东西",
  );
  assert.equal(body.refundRatePercent, "33", "比例照常带出去，与那些键无关");

  for (const abolished of ABOLISHED_BODY_KEYS) {
    assert.equal(
      abolished in body,
      false,
      `已废止的 ${abolished} 不该出现在请求体里（P0-15 起它的语义已经不存在）`,
    );
  }

  // 「退满剩余」这个老意图现在**就是**比例 100%：没有第二条路，也不该有第二个字段
  const full = await captureApproveBody({ refundRatePercent: "100", refundFullRemaining: true });
  assert.deepEqual(keysOf(full), EXPECTED_BODY_KEYS);
  assert.equal(full.refundRatePercent, "100");
});

test("服务端只读 refundRatePercent：已废止的键既补不上缺失的比例，也改不动算出来的比例", async () => {
  // (1) 只有已废止的键 → 与「什么都没填」完全同一种失败。
  //     这正是 P0-14 那个缺陷的形态：界面选了「退满剩余」，实际发出去的却只有
  //     `{ idempotencyKey, reviewNote, responsibility }`，服务端答「请填写退款比例」。
  for (const legacy of [
    { refundFullRemaining: true, responsibility: "platform" },
    { refundFullRemaining: true, responsibility: "shared", companionLiabilityRatePercent: "50" },
    { responsibility: "companion" },
    { refundAmount: 100, platformBorneAmount: 100 },
  ]) {
    assert.deepEqual(
      readAdminRefundDecisionInput(legacy),
      { ok: false, message: REFUND_DECISION_RATE_REQUIRED_MESSAGE },
      `只有旧字段时必须是「请填写退款比例」：${JSON.stringify(legacy)}`,
    );
  }

  // 空串与纯空格算「没填」——旧字段同样补不上（`""` 与 `undefined` 是两件事）
  assert.deepEqual(readAdminRefundDecisionInput({ refundRatePercent: "  ", refundFullRemaining: true }), {
    ok: false,
    message: REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  });

  // (2) 有比例 + 一大堆已废止的键 → 解析结果**恰好**只有比例那一项。
  //     用 deepEqual 整个对象而不是取字段来比：多出一个被读进去的旧字段就会红。
  assert.deepEqual(
    readAdminRefundDecisionInput({
      refundRatePercent: "33",
      refundFullRemaining: true,
      responsibility: "shared",
      companionLiabilityRatePercent: "50",
      refundAmount: 12345,
      platformBorneAmount: 6789,
    }),
    { ok: true, input: { refundRateBp: 3300 } },
    "服务端只读比例：旧字段若被读进去，这里就会看见第二个字段或另一个基点",
  );

  // (3) 形状仍然只有一种：百分比必须是 1~3 位数字的**字符串**。
  //     ⚠️ 数字 `33` 不是「更宽松的写法」——`"0"` 与「没填」必须能分开，
  //     而数字 0 在 `??` 下与 `undefined` 长得一样（见 readAdminRefundDecisionInput 的注释）。
  //     ⚠️ `null` / `undefined` 不在这里：它们落在上一段「没填」那一档，
  //     答的是「请填写退款比例」——「没给」与「给了一个坏值」是两条不同的失败。
  for (const invalid of [33, "33.5", "1e2", "101", "-1", true]) {
    assert.deepEqual(
      readAdminRefundDecisionInput({ refundRatePercent: invalid, responsibility: "platform" }),
      { ok: false, message: REFUND_DECISION_RATE_INVALID_MESSAGE },
      `${JSON.stringify(invalid)} 不是合法的退款比例`,
    );
  }
});

test("金额只由比例决定：退 10% 与退 100% 把打手这一单收益整笔取消（旧字段一个都改不动它）", async () => {
  const orderMoney = {
    originalAmount: 5000,
    couponDiscountAmount: 0,
    actualPaidAmount: 5000,
    refundedAmount: 0,
    companionBaseIncome: 3000,
    clubNetIncome: 2000,
  };

  const ten = previewRefundDecisionAmounts({ orderMoney, refundRatePercent: "10" });
  const full = previewRefundDecisionAmounts({ orderMoney, refundRatePercent: "100" });
  assert.equal(ten.ok, true);
  assert.equal(full.ok, true);

  // 退款额按比例 —— 这两条才是「比例决定退多少钱」
  assert.equal(ten.amounts.refundAmount, 500);
  assert.equal(full.amounts.refundAmount, 5000, "100% 精确等于实付（floor(x × 10000/10000) === x）");

  // 冲回额与比例**无关**：整笔归零。写成 `floor(收益 × 比例)` 之后金额会变得
  // 「挺合理」，只是打手偷偷留下了钱，页面上完全看不出来
  assert.equal(ten.amounts.companionReversalAmount, 3000, "退 10% 也是整笔取消");
  assert.equal(full.amounts.companionReversalAmount, 3000);
  assert.equal(
    ten.amounts.companionReversalAmount,
    orderMoney.companionBaseIncome,
    "冲回额恒等于订单冻结的打手分账基数",
  );

  // 预览与写入路径是**同一个**公式函数，且入参只认比例——
  // 因此「预览说退 500、账上退 500」这句话在这里是可验证的，而不是两处各写一遍
  assert.deepEqual(
    ten.amounts,
    computeRefundDecisionAmounts({
      actualPaidAmount: orderMoney.actualPaidAmount,
      companionBaseIncome: orderMoney.companionBaseIncome,
      input: { refundRateBp: 1000 },
    }),
  );

  // 平台最终净收入 = 实付 − 退款额（旧字段完全没有参与的位置）
  assert.equal(orderMoney.actualPaidAmount - ten.amounts.refundAmount, 4500);
});
