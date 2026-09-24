/**
 * 平台参数的取值规则与文案（P0-1）。
 *
 * 业务规则集中在这里，服务层与页面都从这里取——**上下限只能有一处定义**：
 * 接口校验与表单提示若各写一份，迟早出现「表单说最大 1440、接口却放到 2880」，
 * 而那种不一致只在有人真的填了那个数时才暴露。
 */

/**
 * 公共池超时的下界：**1 分钟**。
 *
 * 为什么不是 0：`0` 会让订单进入公共池的同一瞬间就已经超时——它从未真正
 * 出现在任何打手的池子里就被退掉了。「立刻退款」在业务上等于「这个订单池不存在」，
 * 要表达那个意思应该是不下单，而不是配一个 0 分钟的池子。
 */
export const PUBLIC_POOL_TIMEOUT_MIN_MINUTES = 1;

/**
 * 公共池超时的上界：**1440 分钟（24 小时）**。
 *
 * 为什么有上界：这个参数同时是「用户的钱被平台占住多久」的上限。一个手滑多打一位的
 * `14400`（10 天）会让订单静默地挂上十天而没人察觉，因此宁可拒绝也不接受。
 * 1440 这个数取「一天」，是「超时」这个概念仍然说得通的量级。
 */
export const PUBLIC_POOL_TIMEOUT_MAX_MINUTES = 1440;

/** 预置值与「服务端兜底值」：没有任何配置记录时按这个走。 */
export const PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES = 60;

/**
 * 完成材料自动审核时长的默认值：**10 分钟**（P0-8，需求侧冻结的默认值）。
 *
 * 语义：打手提交完成材料的那一刻起算，10 分钟内仍 pending、无阻塞且订单仍 serving
 * 时由 System 自动通过；客服可以在 10 分钟到点前人工处理。
 */
export const COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES = 10;

/**
 * 完成材料自动审核时长的上下界：**复用**公共池超时的同一套上下限（1 ~ 1440 分钟）。
 *
 * 依据（`02-decisions.md` D5）：两者是**同一个配置实体上的同类量**（整数分钟、
 * 都按 snapshot 冻结、都由同一位管理员在同一个页面改），分别定义一套上下限只会
 * 出现「两个数字慢慢分叉」而无人察觉。默认值 10 落在该区间内，不与任何已确认规则冲突。
 */
export const COMPLETION_AUTO_APPROVAL_MIN_MINUTES = PUBLIC_POOL_TIMEOUT_MIN_MINUTES;
export const COMPLETION_AUTO_APPROVAL_MAX_MINUTES = PUBLIC_POOL_TIMEOUT_MAX_MINUTES;

/**
 * 投诉窗口的默认值：**1440 分钟（24 小时）**（P0-9，产品裁定 2026-09-24）。
 *
 * 语义：订单真正进入 `completed` 的那一刻起算，用户在这么长时间内仍可发起投诉；
 * 同时它也是打手这一单收益的冻结时长——`Earning.availableAt` 等于本单的
 * `complaintDeadlineAt`。
 */
export const COMPLAINT_WINDOW_DEFAULT_MINUTES = 1440;

/**
 * 投诉窗口的下界：**60 分钟（1 小时）**。
 *
 * 为什么不是 1 分钟：这个窗口是用户「发现自己被坑了、并且来得及提交投诉」的时间，
 * 而不是一次系统等待。一个 1 分钟的窗口在业务上等于「关闭投诉」——用户还没看到
 * 结算结果它就到点了，而界面上却仍然写着「可投诉」。要表达「不开放投诉」应该是不做
 * 这个功能，而不是配一个 1 分钟的窗口。
 */
export const COMPLAINT_WINDOW_MIN_MINUTES = 60;

/**
 * 投诉窗口的上界：**10080 分钟（7 天）**。
 *
 * 为什么有上界：这个窗口同时是**打手的钱被冻结多久**的上限。无上界意味着一次手滑
 * 多打一位（如 `144000` ≈ 100 天）会让一批打手的收益静默地冻上一个季度，
 * 而每张订单看起来都「一切正常」。7 天是「投诉仍然说得通」的量级。
 */
export const COMPLAINT_WINDOW_MAX_MINUTES = 10080;

/**
 * ⚠️ 投诉窗口的上下限**独立定义**，不复用公共池超时 / 完成材料自动审核那一组
 * （P0-9 `02-decisions.md` D17）。
 *
 * 两者是**不同语义的量**：超时与自动审核回答「系统等多久」，量级是分钟到一天；
 * 投诉窗口回答「用户还有多久可以翻案」，量级是一小时到一周。共用一组常量会让
 * 「把投诉窗口上限调成 30 天」这件事顺带改掉「公共池最多挂 30 天」——
 * 而后者是「用户的钱被平台占住多久」的上限，绝不该被一次投诉策略调整带着走。
 * 因此这里**不** `import` 那两个常量，宁可各写一份数字。
 */
export function isValidComplaintWindowMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= COMPLAINT_WINDOW_MIN_MINUTES
    && value <= COMPLAINT_WINDOW_MAX_MINUTES;
}

/**
 * 时长是否合法。
 *
 * 五类必须被挡住的输入，各有各的理由：
 * - `0` / 负数：见上界与下界的注释；
 * - 超上界：见上界注释；
 * - **小数**（`1.5`）：时长是整数分钟。接受小数会让「1.5 分钟」与「90 秒」
 *   在系统里变成两个值，而截止时间只应有一个；
 * - **字符串**（`"60"`）：请求体里 `"60"` 与 `60` 长得不一样，来自表单的永远是字符串。
 *   这里**不替调用方转换**——转换是服务层的职责（转换之后仍然要过这道校验），
 *   校验函数一旦开始做隐式转换，「到底存进去了什么」就说不清了；
 * - `NaN` / `Infinity`：它们能通过 `typeof === "number"` 与大小比较的一部分，
 *   必须被 `Number.isInteger` 明确挡掉。
 *
 * 写成类型谓词，是为了让调用方在通过之后**不需要再断言一次**。
 */
export function isValidPublicPoolTimeoutMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= PUBLIC_POOL_TIMEOUT_MIN_MINUTES
    && value <= PUBLIC_POOL_TIMEOUT_MAX_MINUTES;
}

/**
 * 完成材料自动审核时长是否合法（P0-8）。
 *
 * 与公共池超时同一套拒绝理由（0 / 负数 / 超上界 / 小数 / 字符串 / NaN / Infinity），
 * 上下界复用同一组常量。写成类型谓词，让调用方在通过之后不需要再断言一次。
 */
export function isValidCompletionAutoApprovalMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= COMPLETION_AUTO_APPROVAL_MIN_MINUTES
    && value <= COMPLETION_AUTO_APPROVAL_MAX_MINUTES;
}

/**
 * 后台「平台参数」页上的说明文案。
 *
 * ⚠️ **三个参数都必须写明「只影响之后」**：公共池超时只影响此后进入公共池的订单，
 * 完成材料自动审核时长只影响此后提交的完成材料，投诉窗口只影响此后**真正完成**的订单——
 * 管理员改完看到在途订单 / 已提交材料 / 已完成订单没有变化，会以为没保存成功，
 * 然后再改一次。这也正是 EX-CONFIG-06「改配置不追溯」的规则。
 *
 * ⚠️ 投诉窗口那一句必须同时说清**两个后果**：它既是用户可投诉的期限，
 * 也是打手收益的冻结期限。只写「投诉期限」会让管理员以为调小它只影响投诉，
 * 而实际上它提前放款给打手——一次看不出来的资金规则改动。
 */
export const PLATFORM_CONFIG_NOTICE =
  "公共订单池无人接单超时后将停止接取并自动全额退款，完成材料提交后超过自动审核时长且无退款 / 投诉阻塞时将自动通过并完成订单，订单完成后的投诉窗口内用户仍可发起投诉、打手该单收益同时处于冻结状态。修改只影响此后进入公共池的订单、此后提交的完成材料与此后完成的订单，已进入 / 已提交 / 已完成的沿用当时的快照。";

/**
 * 平台参数这份**单例记录**在审计里的目标 id。
 *
 * ⚠️ 平台参数没有 id——它按定义只有一份。审计表却需要一个 `targetId` 才能
 * 按对象查历史，因此这里给一个**固定常量**而不是每次现取：
 * 一个「每次都不一样」的 id 会让「改过几次公共池超时」这件事查不出来。
 */
export const PLATFORM_CONFIG_ID = "platform-config";

/** 缺少或格式非法的幂等键。与其它管理写接口同一句文案。 */
export const PLATFORM_CONFIG_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少幂等键，请重试";

/** 取值非法时的提示。**带上上下限**，否则管理员只知道错了、不知道该填什么。 */
export const PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE =
  `公共池超时必须是 ${PUBLIC_POOL_TIMEOUT_MIN_MINUTES}~${PUBLIC_POOL_TIMEOUT_MAX_MINUTES} 之间的整数分钟`;

/** 完成材料自动审核时长取值非法时的提示（P0-8）。同样带上上下限。 */
export const PLATFORM_CONFIG_INVALID_COMPLETION_AUTO_APPROVAL_MESSAGE =
  `完成材料自动审核时长必须是 ${COMPLETION_AUTO_APPROVAL_MIN_MINUTES}~${COMPLETION_AUTO_APPROVAL_MAX_MINUTES} 之间的整数分钟`;

/** 投诉窗口取值非法时的提示（P0-9）。同样带上上下限。 */
export const PLATFORM_CONFIG_INVALID_COMPLAINT_WINDOW_MESSAGE =
  `投诉窗口必须是 ${COMPLAINT_WINDOW_MIN_MINUTES}~${COMPLAINT_WINDOW_MAX_MINUTES} 之间的整数分钟`;

/** 空 PATCH（一个字段都没带）时的提示。 */
export const PLATFORM_CONFIG_EMPTY_PATCH_MESSAGE = "没有可修改的参数";

/** 幂等键用在了别处（不是本模块、或不是同一个操作者）。 */
export const PLATFORM_CONFIG_OPERATION_CONFLICT_MESSAGE = "该操作标识已被其它请求使用，请重试";
