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
 * 后台「平台参数」页上的说明文案。
 *
 * ⚠️ **必须写明「只影响之后进入公共池的订单」**：这是这个页面最容易被误解的地方——
 * 管理员改完看到在途订单没有变化，会以为没保存成功，然后再改一次。
 */
export const PLATFORM_CONFIG_NOTICE =
  "公共订单池无人接单超时后，订单将停止被接取并自动全额退款。修改后只影响此后进入公共池的订单，已进入的订单沿用进入时的快照。";

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

/** 幂等键用在了别处（不是本模块、或不是同一个操作者）。 */
export const PLATFORM_CONFIG_OPERATION_CONFLICT_MESSAGE = "该操作标识已被其它请求使用，请重试";
